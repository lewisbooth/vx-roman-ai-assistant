import assert from "node:assert/strict";
import { cwd } from "node:process";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { RichText } from './frontend/src/chat/RichText';
      import { Timeline } from './frontend/src/chat/Timeline';
      export function mount(container, navigation) {
        const root = createRoot(container);
        return {
          render(text) {
            flushSync(() => root.render(<RichText text={text} navigation={navigation} />));
          },
          timeline(messages) {
            flushSync(() => root.render(<Timeline messages={messages} navigation={navigation}
              session={{}} onContentChange={() => {}} />));
          },
          dispose() { root.unmount(); },
        };
      }
    `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "RomanRichTextTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "count-markdown-work",
      setup(build) {
        build.onResolve({ filter: /^react-markdown$/ }, (args) =>
          args.namespace === "counter"
            ? undefined
            : { path: args.path, namespace: "counter" },
        );
        build.onLoad({ filter: /.*/, namespace: "counter" }, () => ({
          contents: `import Markdown from 'react-markdown';
          export default function CountedMarkdown(props) {
            window.romanMarkdownRenders = (window.romanMarkdownRenders || 0) + 1;
            return <Markdown {...props} />;
          }`,
          loader: "jsx",
          resolveDir: cwd(),
        }));
      },
    },
  ],
});

function setup(t) {
  const dom = new JSDOM(
    "<!doctype html><roman-ai-assistant></roman-ai-assistant>",
    {
      url: "https://hd-dev-single.myshopify.com/products/current",
      runScripts: "outside-only",
    },
  );
  const { window } = dom;
  window.eval(
    `${bundle.outputFiles[0].text}\nwindow.RomanRichTextTest = RomanRichTextTest;`,
  );
  const host = window.document.querySelector("roman-ai-assistant");
  const container = window.document.createElement("div");
  host.attachShadow({ mode: "open" }).append(container);
  const calls = [];
  const view = window.RomanRichTextTest.mount(container, {
    navigate: async (path) => {
      calls.push(path);
    },
  });
  t.after(() => {
    view.dispose();
    window.close();
  });
  return { window, container, calls, ...view };
}

test("unchanged history and control renders do not reparse Markdown; one changed reply does", (t) => {
  const { window, timeline } = setup(t);
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `reply-${index}`,
    role: "assistant",
    status: "complete",
    createdAt: "2026-09-15T10:00:00Z",
    parts: [
      {
        type: "text",
        text: `**Reply ${index}** with a [product](/products/shade-${index}).`,
      },
    ],
  }));
  timeline(messages);
  assert.equal(window.romanMarkdownRenders, 40);
  for (let index = 0; index < 10; index++)
    timeline(JSON.parse(JSON.stringify(messages)));
  assert.equal(
    window.romanMarkdownRenders,
    40,
    "historical Markdown should not rerender with new snapshot objects",
  );
  messages[39].parts[0].text += " More streamed text.";
  timeline(messages);
  assert.equal(window.romanMarkdownRenders, 41);
});

test("assistant CommonMark has semantic paragraphs, emphasis, nested lists, headings and code", (t) => {
  const { container, render } = setup(t);
  render(
    [
      "## Measuring your window",
      "",
      "Use **three measurements** and note the _smallest width_.",
      "",
      "- Width",
      "  - Top",
      "  - Middle",
      "- Height",
      "",
      "1. Measure",
      "2. Check",
      "",
      "Keep `120 mm` as the unit.",
      "",
      "```text",
      "width < frame",
      "```",
    ].join("\n"),
  );
  assert.equal(
    container.querySelector("h2").textContent,
    "Measuring your window",
  );
  assert.equal(
    container.querySelector("strong").textContent,
    "three measurements",
  );
  assert.equal(container.querySelector("em").textContent, "smallest width");
  assert.equal(container.querySelectorAll("ul ul > li").length, 2);
  assert.deepEqual(
    [...container.querySelectorAll("ol > li")].map((item) => item.textContent),
    ["Measure", "Check"],
  );
  assert.equal(container.querySelector("p code").textContent, "120 mm");
  assert.equal(
    container.querySelector("pre code").textContent,
    "width < frame\n",
  );
  assert.equal(container.querySelectorAll("p").length, 2);
});

test("model HTML, images and external or unsafe links never become active content", (t) => {
  const { window, container, render, calls } = setup(t);
  render(
    [
      "<script>window.compromised = true</script>",
      "",
      '<img src="https://tracker.example/image" onerror="window.compromised=true">',
      "",
      '<iframe src="https://tracker.example"></iframe>',
      "",
      "![Room photo](https://tracker.example/photo.jpg)",
      "",
      "[Script](javascript:alert(1)) [Encoded](javascript&#58;alert(1))",
      "",
      "[Data](data:text/html,unsafe) [Mail](mailto:someone@example.com)",
      "",
      "[External](https://other-store.example/products/shade) [Protocol](//other-store.example/products/shade)",
      "",
      "[Credentials](https://name:secret@hd-dev-single.myshopify.com/products/shade)",
    ].join("\n"),
  );
  assert.equal(
    container.querySelector("script, img, iframe, object, style, form, svg, a"),
    null,
  );
  assert.equal(container.querySelector("[onerror], [onclick], [srcdoc]"), null);
  assert.equal(window.compromised, undefined);
  assert.match(container.textContent, /External/);
  assert.match(container.textContent, /Script/);
  assert.deepEqual(calls, []);
});

test("same-store Markdown links use Roman navigation and preserve modified clicks", (t) => {
  const { window, container, render, calls } = setup(t);
  render("[View the product](/products/roman-blind)");
  const link = container.querySelector("a");
  const destination =
    "https://hd-dev-single.myshopify.com/products/roman-blind";
  assert.equal(link.href, destination);
  function click(settings = {}) {
    let intercepted;
    // Observe React's decision before preventing jsdom from attempting native navigation.
    container.addEventListener(
      "click",
      (event) => {
        intercepted = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );
    link.dispatchEvent(
      new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ...settings,
      }),
    );
    return intercepted;
  }
  assert.equal(click(), true);
  assert.deepEqual(calls, [destination]);
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"])
    assert.equal(click({ [modifier]: true }), false);
  assert.deepEqual(calls, [destination]);
});

test("streamed partial Markdown can complete without duplicate or executable content", (t) => {
  const { window, container, render } = setup(t);
  for (const text of [
    "**Measure",
    "**Measure** the _width",
    "**Measure** the _width_.\n\n[Product](/products/roman",
    "**Measure** the _width_.\n\n[Product](/products/roman)\n\n<script>",
    "**Measure** the _width_.\n\n[Product](/products/roman)\n\n<script>window.compromised=true</script>",
  ]) {
    render(text);
    assert.equal(container.querySelector("script, img, iframe"), null);
    assert.equal(window.compromised, undefined);
  }
  assert.equal(container.querySelectorAll("strong").length, 1);
  assert.equal(container.querySelector("strong").textContent, "Measure");
  assert.equal(container.querySelector("em").textContent, "width");
  assert.equal(container.querySelectorAll("a").length, 1);
  assert.equal(container.querySelector("a").textContent, "Product");
});

test("Timeline formats assistant replies while user messages retain literal syntax", (t) => {
  const { container, timeline } = setup(t);
  const text =
    '**Width** [Product](/products/roman) <img src=x onerror="unsafe()">';
  timeline(
    ["user", "assistant"].map((role) => ({
      id: role,
      role,
      parts: [{ type: "text", text }],
      status: "complete",
      createdAt: "2026-09-15T10:00:00.000Z",
    })),
  );
  const user = container.querySelector(".roman-message-user");
  const assistant = container.querySelector(".roman-message-assistant");
  assert.ok(user.textContent.includes(text));
  assert.equal(user.querySelector("strong, a, img"), null);
  assert.equal(assistant.querySelector("strong").textContent, "Width");
  assert.equal(assistant.querySelector("a").textContent, "Product");
  assert.equal(assistant.querySelector("img"), null);
});

test("an existing focused link retains its DOM node while later reply text streams", (t) => {
  const { container, render } = setup(t);
  const initial = "[View the product](/products/roman) before measuring.";
  render(initial);
  const link = container.querySelector("a");
  link.focus();
  assert.equal(container.getRootNode().activeElement, link);
  render(`${initial}\n\nMeasure the **width** in three places.`);
  assert.equal(container.querySelector("a"), link);
  assert.equal(container.getRootNode().activeElement, link);
  assert.equal(container.querySelector("strong").textContent, "width");
});

test("store-linked PDF guides in Markdown open separately without replacing the voice storefront", (t) => {
  const { window, container, calls, render } = setup(t);
  render(
    "[Measuring guide](/cdn/shop/files/measuring-roman.pdf?v=5729100873718235920)",
  );
  const link = container.querySelector("a");
  assert.equal(
    link.href,
    "https://hd-dev-single.myshopify.com/cdn/shop/files/measuring-roman.pdf?v=5729100873718235920",
  );
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  const click = new window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  link.dispatchEvent(click);
  assert.equal(click.defaultPrevented, false);
  assert.deepEqual(calls, []);
  render(
    "[Foreign guide](https://foreign.example/cdn/shop/files/measuring.pdf)",
  );
  assert.equal(container.querySelector("a"), null);
});

test("authored prose returns create separate paragraphs without splitting naturally wrapped text", (t) => {
  const { container, render } = setup(t);
  const first = "These blinds offer privacy while keeping the room bright.";
  const second = "The fabric and fitting can be chosen for your window.";
  for (const separator of ["\n", "\r\n", "\n\n", "  \n"]) {
    render(`${first}${separator}${second}`);
    assert.deepEqual(
      [...container.querySelectorAll(".roman-rich-text > p")].map(
        (paragraph) => paragraph.textContent,
      ),
      [first, second],
    );
    assert.equal(container.querySelector("br"), null);
  }
  const wrapped = `${first} ${second} ${first}`;
  render(wrapped);
  assert.equal(container.querySelectorAll("p").length, 1);
  assert.equal(container.querySelector("p").textContent, wrapped);
});

test("prose returns preserve inline emphasis and safe storefront links across paragraphs", (t) => {
  const { container, render, calls } = setup(t);
  render(
    "**Light filtering\nDaytime privacy**\n[View the\nproduct](/products/roman) and `300 mm`.",
  );
  const paragraphs = [...container.querySelectorAll(".roman-rich-text > p")];
  assert.deepEqual(
    paragraphs.map((paragraph) => paragraph.textContent),
    ["Light filtering", "Daytime privacy", "View the", "product and 300 mm."],
  );
  assert.deepEqual(
    [...container.querySelectorAll("strong")].map((node) => node.textContent),
    ["Light filtering", "Daytime privacy"],
  );
  assert.equal(container.querySelectorAll("a").length, 2);
  assert.equal(paragraphs[3].querySelector("code").textContent, "300 mm");
  paragraphs[3].querySelector("a").click();
  assert.deepEqual(calls, [
    "https://hd-dev-single.myshopify.com/products/roman",
  ]);
});

test("list continuations and code keep their Markdown layout while surrounding prose separates", (t) => {
  const { container, render } = setup(t);
  render(
    [
      "First overview.",
      "Next thought.",
      "",
      "- A **blackout** option",
      "  with a continuation",
      "  - Nested choice",
      "- A light-filtering option",
      "",
      "1. Measure the width",
      "   at three points",
      "2. Measure the drop",
      "",
      "```text",
      "width = 300",
      "drop = 400",
      "```",
      "",
      "Inline `width\ndrop` stays code.",
    ].join("\n"),
  );
  assert.equal(container.querySelectorAll(".roman-rich-text > p").length, 3);
  assert.equal(container.querySelectorAll("ul ul > li").length, 1);
  assert.match(
    container.querySelector("ul > li").textContent,
    /blackout option\nwith a continuation/,
  );
  assert.equal(container.querySelectorAll("li p").length, 0);
  assert.match(
    container.querySelector("ol > li").textContent,
    /width\nat three points/,
  );
  assert.equal(
    container.querySelector("pre code").textContent,
    "width = 300\ndrop = 400\n",
  );
  assert.equal(container.querySelector("p code").textContent, "width drop");
});

test("streamed prose paragraphs preserve link focus and keep HTML and unsafe links inert", (t) => {
  const { window, container, render } = setup(t);
  const initial = "[View the product](/products/roman) before measuring.";
  render(initial);
  const link = container.querySelector("a");
  link.focus();
  render(`${initial}\nMeasure the **width**.`);
  assert.ok(container.querySelector("a") === link);
  assert.ok(container.getRootNode().activeElement === link);
  assert.equal(container.querySelectorAll("p").length, 2);
  render(
    "Safe first line.\n[Unsafe](javascript:alert(1))\n<img src=x onerror=window.compromised=true>\nSafe last line.",
  );
  assert.equal(container.querySelector("img, script, iframe, a"), null);
  assert.equal(window.compromised, undefined);
  assert.match(container.textContent, /Safe first line/);
  assert.match(container.textContent, /Unsafe/);
});

test("displayed prose trims leading text and bold starts without losing internal word spaces", (t) => {
  const { container, render } = setup(t);
  for (const text of [
    "  Roman can help.",
    "&nbsp; Roman can help.",
    "&nbsp; **Roman** can help.",
    "**&#32;Roman** can help.",
  ]) {
    render(text);
    assert.equal(container.querySelector("p").textContent, "Roman can help.");
  }
  render("First thought.\n&nbsp; **Another** thought with  two spaces.");
  assert.deepEqual(
    [...container.querySelectorAll("p")].map(
      (paragraph) => paragraph.textContent,
    ),
    ["First thought.", "Another thought with  two spaces."],
  );
  assert.equal(container.querySelector("strong").textContent, "Another");
});

test("streaming an indented prose start retains a single word separator and stable emphasis", (t) => {
  const { container, render } = setup(t);
  render("&nbsp; **Roman**");
  const bold = container.querySelector("strong");
  for (const suffix of [" can", " can help", " can help you."]) {
    render(`&nbsp; **Roman**${suffix}`);
    assert.equal(container.querySelector("p").textContent, `Roman${suffix}`);
    assert.ok(container.querySelector("strong") === bold);
  }
});

test("leading-space cleanup preserves indented, fenced and inline code whitespace", (t) => {
  const { container, render } = setup(t);
  render("    if (width) {\n      measure();\n    }");
  assert.equal(
    container.querySelector("pre code").textContent,
    "if (width) {\n  measure();\n}\n",
  );
  render("```text\n  width = 300\n    drop = 400\n```");
  assert.equal(
    container.querySelector("pre code").textContent,
    "  width = 300\n    drop = 400\n",
  );
  render("&nbsp; `  300 mm  ` stays code.");
  assert.equal(container.querySelector("p code").textContent, " 300 mm ");
  assert.equal(
    container.querySelector("p").textContent,
    " 300 mm  stays code.",
  );
});

test("voice captions trim only the displayed leading space while stored text stays unchanged", (t) => {
  const { container, timeline } = setup(t);
  const text = " \n\tHi I'm Roman. Keep  these spaces. ";
  const part = Object.freeze({
    type: "voice",
    version: 1,
    voiceId: "22222222-2222-4222-8222-222222222222",
    text,
    startMs: 0,
    endMs: 100,
  });
  timeline([
    {
      id: "voice-reply",
      role: "assistant",
      status: "complete",
      createdAt: "2026-09-15T10:00:00.000Z",
      parts: [part],
    },
  ]);
  assert.equal(
    container.querySelector(".roman-voice-caption p").textContent,
    "Hi I'm Roman. Keep  these spaces. ",
  );
  assert.equal(part.text, text);
});

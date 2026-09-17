import assert from "node:assert/strict";
import { cwd } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { Question } from './frontend/src/chat/Question';
      export function mount(container) {
        const root = createRoot(container);
        return {
          render(props) { flushSync(() => root.render(<Question key={props.part.invocationId} {...props} />)); },
          flush(callback) { flushSync(callback); },
          dispose() { flushSync(() => root.unmount()); },
        };
      }
    `,
    resolveDir: cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "MeasurementQuestionTest",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

const part = {
  type: "question",
  version: 1,
  invocationId: "482b025d-2e66-4dd7-8fbe-beb2b2ee0c83",
  question: "How much clearance is available?",
  answers: [],
  measurement: {
    productPath: "/products/example-blind",
    label: "Recess clearance",
    unit: "in",
    instructions: "Measure from the handle to the front of the recess.",
  },
};

async function until(condition) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail("The measurement question did not reach its expected state.");
}

function setup(t, options = {}) {
  const dom = new JSDOM(
    "<!doctype html><roman-ai-assistant></roman-ai-assistant>",
    {
      url: "https://hd-dev-single.myshopify.com/products/example-blind",
      runScripts: "outside-only",
    },
  );
  const { window } = dom;
  const failures = [];
  const calls = [];
  window.console.error = (...args) => failures.push(args);
  window.fetch = () =>
    assert.fail("Question UI cannot fetch or mutate the storefront.");
  const shadow = window.document
    .querySelector("roman-ai-assistant")
    .attachShadow({ mode: "open" });
  const elsewhere = window.document.createElement("button");
  elsewhere.textContent = "Mute microphone";
  const container = window.document.createElement("div");
  shadow.append(elsewhere, container);
  elsewhere.focus();
  window.eval(
    `${bundle.outputFiles[0].text};window.MeasurementQuestionTest=MeasurementQuestionTest;`,
  );
  const view = window.MeasurementQuestionTest.mount(container);
  let props = {
    part,
    active: true,
    disabled: false,
    voice: false,
    ...options,
    onAnswer: async (...args) => {
      calls.push(args);
      await options.onAnswer?.(...args, window);
    },
  };
  const render = (updates = {}) => {
    props = { ...props, ...updates };
    view.render(props);
  };
  render();
  t.after(() => {
    view.dispose();
    window.close();
    assert.deepEqual(failures, []);
  });
  const input = () => container.querySelector('input[type="number"]');
  const fill = (value) =>
    view.flush(() => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set.call(input(), value);
      input().dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  const submit = () =>
    view.flush(() =>
      container
        .querySelector("form")
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
  return {
    window,
    shadow,
    container,
    elsewhere,
    calls,
    render,
    input,
    fill,
    submit,
    flush: view.flush,
  };
}

test("measurement input has explicit units and guide instructions without stealing voice focus", (t) => {
  const ctx = setup(t, { voice: true });
  const input = ctx.input();
  assert.equal(ctx.shadow.activeElement, ctx.elsewhere);
  assert.equal(input.step, "any");
  assert.equal(input.min, "0");
  assert.equal(input.max, "");
  assert.equal(input.inputMode, "decimal");
  assert.equal(input.labels[0].textContent, "Recess clearance (in)");
  assert.equal(
    ctx.shadow.getElementById(input.getAttribute("aria-describedby"))
      .textContent,
    part.measurement.instructions,
  );
  assert.match(
    ctx.container.querySelector(".roman-question-hint").textContent,
    /Reply aloud or enter your measurement/,
  );
  assert.equal(
    ctx.container.querySelector(".roman-question").getAttribute("aria-busy"),
    "false",
  );
  assert.deepEqual(ctx.calls, []);
});

test("decimal submission uses the canonical answer and locks repeated submit/actions while pending", async (t) => {
  let finish;
  const ctx = setup(t, {
    onAnswer: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  ctx.fill("20.5");
  ctx.input().focus();
  ctx.submit();
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], part);
  assert.equal(ctx.calls[0][1], "Recess clearance: 20.5 in");
  assert.equal(ctx.input().value, "20.5");
  assert.equal(ctx.input().readOnly, true);
  assert.equal(ctx.shadow.activeElement, ctx.input());
  assert.equal(
    ctx.container.querySelector(".roman-question").getAttribute("aria-busy"),
    "true",
  );
  assert.ok(
    [...ctx.container.querySelectorAll("button")].every(
      (button) => button.disabled,
    ),
  );
  ctx.submit();
  for (const button of ctx.container.querySelectorAll("button")) button.click();
  assert.equal(ctx.calls.length, 1);
  finish();
  await until(() => !ctx.input().readOnly);
  assert.equal(ctx.calls.length, 1);
});

test("invalid numbers stay editable with an associated error and zero remains a valid clearance", async (t) => {
  const ctx = setup(t);
  for (const value of ["", "-1", "1e2"]) {
    ctx.fill(value);
    ctx.submit();
    assert.equal(ctx.calls.length, 0);
    assert.equal(ctx.input().getAttribute("aria-invalid"), "true");
    const error = ctx.container.querySelector('[role="alert"]');
    assert.ok(error);
    assert.ok(
      ctx
        .input()
        .getAttribute("aria-describedby")
        .split(" ")
        .includes(error.id),
    );
    assert.equal(ctx.input().readOnly, false);
  }
  ctx.fill("0");
  assert.equal(ctx.container.querySelector('[role="alert"]'), null);
  ctx.submit();
  await until(() => !ctx.input().readOnly);
  assert.equal(ctx.calls[0][1], "Recess clearance: 0 in");
});

test("submission failure retains the value and permits editing/retry without automatic replay", async (t) => {
  let attempts = 0;
  const ctx = setup(t, {
    onAnswer: (_part, _answer, window) => {
      if (++attempts === 1)
        throw new window.Error("Connection lost. Try again.");
    },
  });
  ctx.fill(".5");
  ctx.submit();
  await until(() => ctx.container.querySelector('[role="alert"]'));
  assert.equal(ctx.input().value, ".5");
  assert.equal(ctx.input().readOnly, false);
  assert.equal(ctx.input().getAttribute("aria-invalid"), "false");
  assert.equal(ctx.calls.length, 1);
  assert.match(
    ctx.container.querySelector('[role="alert"]').textContent,
    /Connection lost/,
  );
  ctx.fill(".75");
  ctx.submit();
  await until(() => !ctx.input().readOnly);
  assert.deepEqual(
    ctx.calls.map((call) => call[1]),
    ["Recess clearance: .5 in", "Recess clearance: .75 in"],
  );
});

test("change units and stop measuring use the same answer callback without requiring a number", async (t) => {
  for (const action of ["Change units", "Stop measuring"])
    await t.test(action, async (t) => {
      const ctx = setup(t, { voice: true });
      ctx.fill("12.25");
      const button = [...ctx.container.querySelectorAll("button")].find(
        (button) => button.textContent === action,
      );
      ctx.flush(() => button.click());
      await until(() => !ctx.input().readOnly);
      assert.deepEqual(
        ctx.calls.map((call) => call[1]),
        [action],
      );
      assert.equal(ctx.input().value, "12.25");
    });
});

test("disabled and retired questions cannot submit; history retains guide instructions and units", (t) => {
  const ctx = setup(t, { disabled: true });
  assert.equal(ctx.input().disabled, true);
  assert.ok(
    [...ctx.container.querySelectorAll("button")].every(
      (button) => button.disabled,
    ),
  );
  ctx.submit();
  assert.deepEqual(ctx.calls, []);
  ctx.render({ disabled: false });
  ctx.fill("10");
  ctx.render({ active: false });
  assert.equal(ctx.input(), null);
  assert.equal(
    ctx.container.querySelector("form, button, .roman-question"),
    null,
  );
  assert.ok(ctx.container.textContent.includes(part.question));
  assert.ok(ctx.container.textContent.includes(part.measurement.instructions));
  assert.ok(ctx.container.textContent.includes("Recess clearance (in)"));
  assert.equal(ctx.shadow.activeElement, ctx.elsewhere);
});

test("the next measurement question starts empty without reusing the earlier value or moving focus", (t) => {
  const ctx = setup(t);
  ctx.fill("25");
  ctx.render({
    part: {
      ...part,
      invocationId: "6cbecb55-dd6f-47d7-ab8c-81272fd01214",
      measurement: { ...part.measurement, label: "Width", unit: "cm" },
    },
  });
  assert.equal(ctx.input().value, "");
  assert.equal(ctx.input().labels[0].textContent, "Width (cm)");
  assert.equal(ctx.shadow.activeElement, ctx.elsewhere);
});

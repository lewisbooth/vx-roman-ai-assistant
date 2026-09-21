import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = await build({
  entryPoints: ["frontend/src/storefront-scroll.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "StorefrontScroll",
  platform: "browser",
});

function setup(t) {
  const dom = new JSDOM("<body><input value='500'><section id='target'></section></body>", {
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  window.scrollX = 12;
  window.scrollY = 850;
  window.scrollTo = ({ left, top }) => {
    calls.push([left, top]);
    window.scrollX = left;
    window.scrollY = top;
  };
  window.eval(`${bundle.outputFiles[0].text}\nwindow.StorefrontScroll = StorefrontScroll;`);
  const owner = window.StorefrontScroll.createStorefrontScroll();
  t.after(() => owner.dispose());
  return { window, owner, calls, body: window.document.body };
}

test("lock preserves native product controls and restores prior inline styles and scroll", (t) => {
  const { window, owner, body, calls } = setup(t);
  body.style.setProperty("position", "relative");
  body.style.setProperty("top", "3px", "important");
  body.style.setProperty("color", "red");
  owner.setLocked(true);
  assert.equal(body.style.position, "fixed");
  assert.equal(body.style.top, "-850px");
  assert.equal(body.style.left, "-12px");
  assert.equal(body.style.getPropertyPriority("position"), "important");
  assert.equal(body.querySelector("input").value, "500");
  assert.equal(body.hidden, false);
  assert.equal(body.hasAttribute("inert"), false);
  window.scrollY = 0;
  window.scrollX = 0;
  assert.deepEqual([...owner.getPosition()], [12, 850]);
  owner.setLocked(false);
  assert.equal(body.style.position, "relative");
  assert.equal(body.style.top, "3px");
  assert.equal(body.style.getPropertyPriority("top"), "important");
  assert.equal(body.style.left, "");
  assert.equal(body.style.width, "");
  assert.equal(body.style.color, "red");
  assert.deepEqual(calls, [[12, 850]]);
  owner.dispose();
  assert.equal(calls.length, 1, "Repeated cleanup does not move the page");
});

test("background navigation restores its destination rather than the opening scroll", (t) => {
  const { owner, body, calls } = setup(t);
  owner.setLocked(true);
  owner.scrollTo([0, 0]);
  assert.deepEqual([...owner.getPosition()], [0, 0]);
  assert.equal(body.style.top, "0px");
  assert.equal(calls.length, 0);
  owner.setLocked(true);
  assert.deepEqual([...owner.getPosition()], [0, 0]);
  owner.dispose();
  assert.deepEqual(calls, [[0, 0]]);
});

test("locked anchors use document coordinates and CSS scroll margin", (t) => {
  const { owner, window, body, calls } = setup(t);
  const target = window.document.getElementById("target");
  target.style.scrollMarginTop = "50px";
  target.getBoundingClientRect = () => ({ top: 250 });
  owner.setLocked(true);
  owner.scrollIntoView(target);
  assert.deepEqual([...owner.getPosition()], [12, 1050]);
  assert.equal(body.style.top, "-1050px");
  owner.setLocked(false);
  assert.deepEqual(calls, [[12, 1050]]);
});

test("closed mode delegates native scrolling and lock cleanup preserves newer theme edits", (t) => {
  const { owner, window, body, calls } = setup(t);
  owner.scrollTo([4, 120]);
  assert.deepEqual(calls, [[4, 120]]);
  let nativeAnchor = false;
  const target = window.document.getElementById("target");
  target.scrollIntoView = () => { nativeAnchor = true; };
  owner.scrollIntoView(target);
  assert.equal(nativeAnchor, true);
  owner.setLocked(true);
  const position = owner.getPosition();
  position[1] = 999;
  assert.equal(owner.getPosition()[1], 120, "Callers cannot mutate owned scroll state");
  body.style.setProperty("width", "90%");
  owner.setLocked(false);
  assert.equal(body.style.width, "90%");
  assert.equal(body.style.position, "");
  owner.setLocked(true);
  owner.setLocked(false);
  assert.equal(body.style.width, "90%", "Reopening snapshots current theme styles");
});

test("the locked document canvas is ivory and restores the theme background on close or disposal", (t) => {
  const { window, owner, body } = setup(t);
  const root = window.document.documentElement;
  root.style.backgroundImage = 'url("/theme-texture.png")';
  root.style.backgroundRepeat = "repeat-x";
  root.style.backgroundPosition = "center";
  root.style.backgroundSize = "cover";
  root.style.setProperty("background-color", "navy", "important");
  assert.match(root.style.backgroundImage, /theme-texture\.png/);
  assert.equal(root.style.backgroundColor, "navy");
  const properties = [
    "background-color",
    "background-image",
    "background-repeat",
    "background-position",
    "background-size",
  ];
  const snapshot = () => properties.map((name) => [
    name,
    root.style.getPropertyValue(name),
    root.style.getPropertyPriority(name),
  ]);
  const original = snapshot();
  for (const close of [() => owner.setLocked(false), () => owner.dispose()]) {
    owner.setLocked(true);
    assert.equal(window.getComputedStyle(root).backgroundColor, "rgb(247, 245, 239)");
    assert.equal(root.style.backgroundImage, "none");
    assert.equal(root.style.getPropertyPriority("background-color"), "important");
    assert.equal(root.style.getPropertyPriority("background-image"), "important");
    assert.equal(body.querySelector("input").value, "500");
    assert.equal(root.hasAttribute("inert"), false);
    assert.notEqual(window.getComputedStyle(body).visibility, "hidden");
    close();
    assert.deepEqual(snapshot(), original);
  }
});

test("canvas cleanup preserves newer theme edits and removes only owned inline overrides", (t) => {
  const { window, owner } = setup(t);
  const root = window.document.documentElement;
  owner.setLocked(true);
  root.style.setProperty("background-image", 'url("/new-theme.png")');
  const newerImage = root.style.backgroundImage;
  owner.setLocked(false);
  assert.equal(root.style.backgroundColor, "");
  assert.equal(root.style.backgroundImage, newerImage);
  assert.equal(root.style.getPropertyPriority("background-image"), "");
  owner.setLocked(true);
  assert.equal(root.style.backgroundImage, "none");
  owner.dispose();
  assert.equal(root.style.backgroundColor, "");
  assert.equal(root.style.backgroundImage, newerImage);
});

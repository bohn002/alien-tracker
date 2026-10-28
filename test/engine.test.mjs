import {test} from "node:test";
import assert from "node:assert/strict";
import {band, isMoving, floorOffset, toContact, jitter} from "../scripts/engine.js";

const BANDS = {short: 10, medium: 25, long: 50};

test("band boundaries", () => {
  assert.equal(band(0, BANDS), "SHORT");
  assert.equal(band(10, BANDS), "SHORT");
  assert.equal(band(10.01, BANDS), "MEDIUM");
  assert.equal(band(25, BANDS), "MEDIUM");
  assert.equal(band(25.5, BANDS), "LONG");
  assert.equal(band(50, BANDS), "LONG");
  assert.equal(band(50.01, BANDS), "EXTREME");
});

test("isMoving: always and dormant ignore timing", () => {
  assert.equal(isMoving("always", null, 1000, 6000), true);
  assert.equal(isMoving("dormant", 999, 1000, 6000), false);
});

test("isMoving: auto uses the motion window", () => {
  assert.equal(isMoving("auto", 4000, 10000, 6000), true); // exactly at the window edge
  assert.equal(isMoving("auto", 5000, 10000, 6000), true); // recent
  assert.equal(isMoving("auto", 3000, 10000, 6000), false); // stale
  assert.equal(isMoving("auto", null, 10000, 6000), false); // never moved
});

test("floorOffset: point inside a floor is shifted and tagged", () => {
  const floors = [{level: 1, x: 100, y: 200, w: 50, h: 50}];
  assert.deepEqual(floorOffset({x: 120, y: 230}, floors), {x: 20, y: 30, level: 1});
});

test("floorOffset: point outside every floor is unchanged with null level", () => {
  const floors = [{level: 1, x: 100, y: 200, w: 50, h: 50}];
  assert.deepEqual(floorOffset({x: 10, y: 10}, floors), {x: 10, y: 10, level: null});
  assert.deepEqual(floorOffset({x: 10, y: 10}, []), {x: 10, y: 10, level: null});
});

test("floorOffset: edges are inclusive", () => {
  const floors = [{level: 2, x: 100, y: 200, w: 50, h: 50}];
  assert.deepEqual(floorOffset({x: 100, y: 200}, floors), {x: 0, y: 0, level: 2});
  assert.deepEqual(floorOffset({x: 150, y: 250}, floors), {x: 50, y: 50, level: 2});
});

test("floorOffset: first matching floor wins", () => {
  const floors = [
    {level: 1, x: 0, y: 0, w: 100, h: 100},
    {level: 2, x: 0, y: 0, w: 100, h: 100},
  ];
  assert.equal(floorOffset({x: 5, y: 5}, floors).level, 1);
});

const OPTS = {gridSize: 100, gridDistance: 1, floorHeight: 3};

test("toContact: same floor, straight line", () => {
  const c = toContact({x: 0, y: 0, level: 1}, {x: 300, y: 400, level: 1}, OPTS);
  assert.equal(c.d, 5); // 500px / 100px per unit
  assert.equal(c.b, Math.atan2(400, 300));
  assert.equal(c.elev, 0);
});

test("toContact: one floor up adds floorHeight and reports elev 1", () => {
  const c = toContact({x: 0, y: 0, level: 1}, {x: 300, y: 400, level: 2, elevation: 0}, OPTS);
  // horizontal 5, vertical 3 -> hypot(5, 3)
  assert.equal(c.d, Math.hypot(5, 3));
  assert.equal(c.elev, 1);
});

test("toContact: one floor down reports elev -1", () => {
  const c = toContact({x: 0, y: 0, level: 2}, {x: 0, y: 0, level: 1}, OPTS);
  assert.equal(c.d, 3);
  assert.equal(c.elev, -1);
});

test("toContact: null level on one side ignores level difference", () => {
  const c = toContact({x: 0, y: 0, level: null}, {x: 300, y: 400, level: 2}, OPTS);
  assert.equal(c.d, 5);
  assert.equal(c.elev, 0);
  const c2 = toContact({x: 0, y: 0, level: 2}, {x: 300, y: 400, level: null}, OPTS);
  assert.equal(c2.d, 5);
});

test("toContact: pure elevation difference", () => {
  const c = toContact({x: 0, y: 0, elevation: 4}, {x: 0, y: 0, elevation: 1}, OPTS);
  assert.equal(c.d, 3);
  assert.equal(c.elev, -1);
  const c2 = toContact({x: 0, y: 0}, {x: 0, y: 0, elevation: 2}, OPTS);
  assert.equal(c2.d, 2);
  assert.equal(c2.elev, 1);
});

test("toContact: level and elevation combine", () => {
  const c = toContact({x: 0, y: 0, level: 1, elevation: 0}, {x: 0, y: 0, level: 2, elevation: 1}, OPTS);
  assert.equal(c.d, 4); // vertical 3 + 1
  assert.equal(c.elev, 1);
});

test("jitter clamps at zero", () => {
  assert.equal(jitter(0, () => 0), 0); // -1 clamped to 0
  assert.equal(jitter(0.2, () => 0), 0);
});

test("jitter stays within plus or minus 1", () => {
  assert.equal(jitter(10, () => 0), 9);
  assert.equal(jitter(10, () => 0.5), 10);
  assert.equal(jitter(10, () => 0.999), 11);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildMihomoConfig } from "../src/server/proxy-service.mjs";

const nodes = "proxies:\n  - {name: test-node, type: http, server: 127.0.0.1, port: 9000}\n";

test("node-only YAML gets automatic selection and a proxy catch-all", () => {
  const config = buildMihomoConfig(nodes, 23210);
  assert.match(config, /include-all-proxies: true/);
  assert.match(config, /tolerance: 0/);
  assert.match(config, /MATCH,WORKBENCH-IMAGE-RELAY/);
  assert.match(config, /^mode: rule$/m);
  assert.ok(config.includes(nodes));
});

test("empty rules are replaced without duplicate top-level keys", () => {
  for (const rules of ["rules: []\n", "rules:\n", "rules: null\n"]) {
    const config = buildMihomoConfig(`${rules}${nodes}proxy-groups: []\nmode: direct\n`, 23210);
    assert.equal(config.match(/^rules:/gm)?.length, 1);
    assert.equal(config.match(/^proxy-groups:/gm)?.length, 1);
    assert.match(config, /^mode: rule$/m);
  }
});

test("existing block and inline routing policies remain unchanged", () => {
  for (const rules of ["rules:\n  - MATCH,test-node\n", "rules: [MATCH,test-node]\n"]) {
    const config = buildMihomoConfig(`${nodes}${rules}mode: global\n`, 23210);
    assert.ok(config.includes(rules));
    assert.match(config, /^mode: global$/m);
    assert.doesNotMatch(config, /WORKBENCH-IMAGE-RELAY/);
  }
});

test("existing block groups survive automatic route completion", () => {
  const config = buildMihomoConfig(`${nodes}proxy-groups:\n  - name: custom\n    type: select\n    proxies: [test-node]\n`, 23210);
  assert.match(config, /name: custom/);
  assert.match(config, /MATCH,WORKBENCH-IMAGE-RELAY/);
});

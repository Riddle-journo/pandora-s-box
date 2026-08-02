// Guards for the two REPO-CONFIG claims this workstream got wrong once, both of
// which were invisible to every other test:
//
//   1. eslint.config.js grew a `scripts/**: { "no-console": "off" }` override and
//      the change was reported as "removes 122 of 226 warnings". It removed none:
//      no-console is enabled by exactly one block (server/**), so it was never on
//      for scripts/** and the override could not turn anything off. A config block
//      that cannot change any result is worse than no block — it documents an
//      enforcement that does not exist.
//   2. tsconfig.json excludes four server/detectors files whose import closures
//      carry pre-existing type errors, and JSDoc types were added to three of them
//      in the same change. `npm run typecheck` never reads those files, so those
//      annotations were unverifiable and free to rot.
//
// Both assertions are structural and cheap: no linting or type-checking is run
// here, only config resolution.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// tsconfig.json is JSONC (tsc's own parser allows comments), so strip whole-line
// comments before JSON.parse. Only line comments are used in the file, and no
// string value in it contains "//".
function readJsonc(rel) {
  const src = read(rel)
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  return JSON.parse(src);
}

describe("tsconfig: no type annotations in files the checker never reads", () => {
  const tsconfig = readJsonc("tsconfig.json");
  const excludedJs = (tsconfig.exclude ?? []).filter((p) => p.endsWith(".js"));

  it("the exclude list is non-empty and every entry still exists", () => {
    assert.ok(excludedJs.length > 0, "expected per-file .js exclusions to audit");
    for (const rel of excludedJs) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is excluded but no longer exists — stale entry`);
    }
  });

  it("no excluded file carries a JSDoc type annotation", () => {
    // @type / @param {…} / @returns {…} / @typedef in an EXCLUDED file is a type
    // assertion nothing can verify: `npm run typecheck` does not load the file, so
    // the annotation may already be wrong and no tool will say so. Either delete
    // the exclusion (once its closure typechecks clean) or leave the file
    // annotation-free — see the rationale comment in tsconfig.json.
    const offenders = [];
    for (const rel of excludedJs) {
      const src = read(rel);
      for (const [i, line] of src.split("\n").entries()) {
        if (/@(type|param|returns|typedef)\s*\{/.test(line)) offenders.push(`${rel}:${i + 1}`);
      }
    }
    assert.deepEqual(offenders, [], "annotations in tsconfig-excluded files are unverifiable");
  });

  it("the detector files that ARE annotated are inside the program", () => {
    // The counterpart check: annotations only pay off in files tsc reads, so at
    // least the annotated, non-excluded detectors must not drift into exclude.
    const annotated = fs.readdirSync(path.join(ROOT, "server", "detectors"))
      .filter((f) => f.endsWith(".js"))
      .filter((f) => /@(type|param|returns|typedef)\s*\{/.test(read(path.join("server/detectors", f))))
      .map((f) => "server/detectors/" + f);
    assert.ok(annotated.length > 0, "expected some annotated detector files");
    for (const rel of annotated) {
      assert.ok(!excludedJs.includes(rel), `${rel} carries JSDoc types but is excluded from tsconfig`);
    }
  });
});

describe("eslint: every rule-disabling block actually disables something", () => {
  it("no-console is enabled in exactly the scope the comment claims", async () => {
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({ cwd: ROOT });
    const sev = async (rel) => {
      const cfg = await eslint.calculateConfigForFile(path.join(ROOT, rel));
      return cfg.rules?.["no-console"]?.[0] ?? "off";
    };
    // server/** is the ONLY place raw console is treated as debt.
    assert.equal(await sev("server/index.js"), 1, "server/** must warn on console");
    for (const rel of ["scripts/smoke.js", "test/api-config-scope.test.js", "public/js/api.js"]) {
      assert.equal(await sev(rel), "off", `${rel} must not be counted for no-console`);
    }
  });

  it("no config block switches a rule off that nothing turned on for its files", async () => {
    // The dead-override detector. For every block that sets a rule to "off", the
    // block is REMOVED and the rule is re-resolved for real files it matches: if
    // the rule was not enabled there anyway, the block changes nothing and only
    // misleads whoever reads it (or reports a warning reduction that never
    // happened). Written generically so it catches the next one too.
    const { ESLint } = await import("eslint");
    const config = (await import("../eslint.config.js")).default;

    // Real .js files matching a flat-config `files` pattern, for the shapes this
    // config uses: "<dir>/**/*.js" and "*.js".
    const samples = (pattern) => {
      const m = /^(.+)\/\*\*\/\*\.js$/.exec(pattern);
      if (m) {
        const out = [];
        const walk = (dir) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (out.length >= 2) return;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); }
            else if (e.name.endsWith(".js")) out.push(p);
          }
        };
        const base = path.join(ROOT, m[1]);
        if (fs.existsSync(base)) walk(base);
        return out;
      }
      if (pattern === "*.js") {
        return fs.readdirSync(ROOT).filter((f) => f.endsWith(".js")).slice(0, 2).map((f) => path.join(ROOT, f));
      }
      return [];
    };

    let audited = 0;
    for (const [i, block] of config.entries()) {
      for (const [rule, setting] of Object.entries(block.rules ?? {})) {
        const off = setting === "off" || setting === 0 || (Array.isArray(setting) && (setting[0] === "off" || setting[0] === 0));
        if (!off) continue;
        const without = new ESLint({ cwd: ROOT, overrideConfigFile: true, baseConfig: config.filter((_, j) => j !== i) });
        for (const pattern of block.files ?? []) {
          const files = samples(pattern);
          assert.ok(files.length > 0, `could not resolve a real file for pattern ${pattern}`);
          for (const f of files) {
            const resolved = await without.calculateConfigForFile(f);
            audited++;
            assert.ok(
              resolved.rules?.[rule] && resolved.rules[rule][0] !== 0,
              `eslint.config.js block #${i} turns "${rule}" off for ${pattern}, but nothing enables it there `
              + `(checked ${path.relative(ROOT, f)}) — the block is inert; delete it or enable the rule first`,
            );
          }
        }
      }
    }
    // Nothing to audit is a pass, but say so out loud rather than passing blindly.
    assert.ok(audited >= 0);
  });
});

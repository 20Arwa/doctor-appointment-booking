import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rolePath = path.join(projectRoot, "lib", "homepage-role.ts");
const roleModule = new Module(rolePath);
roleModule.filename = rolePath;
roleModule.paths = Module._nodeModulePaths(path.dirname(rolePath));
roleModule._compile(ts.transpileModule(fs.readFileSync(rolePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, rolePath);
const { resolveHomepageRole } = roleModule.exports;

describe("shared homepage role resolution", () => {
  it("identifies guests and authenticated patient profiles", () => {
    assert.equal(resolveHomepageRole(true, false, undefined, null), "guest");
    assert.equal(resolveHomepageRole(true, true, "patient-1", { userId: "patient-1", role: "patient" }), "patient");
  });

  it("identifies a doctor only after resolving the current user's profile", () => {
    assert.equal(resolveHomepageRole(true, true, "doctor-1", null), "loading");
    assert.equal(resolveHomepageRole(true, true, "doctor-1", { userId: "doctor-1", role: "doctor" }), "doctor");
    assert.equal(resolveHomepageRole(true, true, "patient-1", { userId: "doctor-1", role: "doctor" }), "loading");
  });

  it("keeps profile-not-found accounts out of patient and doctor role branches", () => {
    assert.equal(resolveHomepageRole(true, true, "new-user", { userId: "new-user", role: null }), "unknown");
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const specialtiesPath = path.join(projectRoot, "lib", "medical-specialties.ts");
const specialtiesModule = new Module(specialtiesPath);
specialtiesModule.filename = specialtiesPath;
specialtiesModule.paths = Module._nodeModulePaths(path.dirname(specialtiesPath));
specialtiesModule._compile(ts.transpileModule(fs.readFileSync(specialtiesPath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, specialtiesPath);
const { MEDICAL_SPECIALTIES, matchesMedicalSpecialty, resolveMedicalSpecialty } = specialtiesModule.exports;

describe("patient booking specialty query filter", () => {
  it("decodes and applies every specialty value to matching doctor records", () => {
    for (const specialty of MEDICAL_SPECIALTIES) {
      const params = new URLSearchParams();
      params.set("specialty", specialty);
      const selectedSpecialty = resolveMedicalSpecialty(new URLSearchParams(params.toString()).get("specialty"));
      const doctors = [
        { specialty },
        { specialty: "Cardiology" },
        { specialty: " General Practice " },
      ];
      const visible = doctors.filter((doctor) => matchesMedicalSpecialty(doctor.specialty, selectedSpecialty));
      assert.equal(selectedSpecialty, specialty);
      assert.ok(visible.length > 0);
      assert.ok(visible.every((doctor) => doctor.specialty.trim().toLocaleLowerCase("en") === specialty.toLocaleLowerCase("en")));
    }
  });

  it("matches specialty values without case or surrounding whitespace differences", () => {
    assert.equal(resolveMedicalSpecialty(new URLSearchParams("specialty=%20fAmIlY%20mEdIcInE%20").get("specialty")), "Family Medicine");
    assert.equal(matchesMedicalSpecialty("  family medicine ", "Family Medicine"), true);
  });

  it("falls back to all specialties for absent or unknown query values", () => {
    assert.equal(resolveMedicalSpecialty(null), "all");
    assert.equal(resolveMedicalSpecialty("not-a-specialty"), "all");
    assert.equal(matchesMedicalSpecialty("Cardiology", "all"), true);
  });
});

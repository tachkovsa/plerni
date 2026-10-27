#!/usr/bin/env node
/**
 * SCA fixture generator (plan T14).
 *
 * Writes a npm lockfile v3 into a caller-supplied directory and nowhere
 * else. The vulnerable pin is lodash 4.17.20, the version cited for
 * CVE-2021-23337 (GHSA-35jh-r3h4-6jhm, fixed in 4.17.21):
 * https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm
 * The integrity is the public registry value for that version, read
 * 2026-10-27 from https://registry.npmjs.org/lodash/4.17.20
 *
 * The lockfile is generated at run time. It is not a project dependency
 * and must not be committed. osv-scanner has no path exclusion, so this
 * file never lands in the tree the real SCA job scans.
 *
 * --clean writes plerni-sca-clean-fixture@1.0.0, a name a scan on
 * 2026-10-27 reported with no advisories. That file is the positive
 * control, not the negative proof.
 */
import { realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const FIXTURE_ADVISORY = "CVE-2021-23337";
export const FIXTURE_PACKAGE = "lodash";
export const FIXTURE_VERSION = "4.17.20";

export const VULN_SPEC = {
  name: FIXTURE_PACKAGE,
  version: FIXTURE_VERSION,
  resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
  integrity: "sha512-PlhdFcillOINfeV7Ni6oF1TAEayyZBoZ8bcshTHqOYJYlrqzRK5hagpagky5o4HfCzzd1TRkXPMFq6cKk9rGmA==",
};

const CLEAN = {
  name: "plerni-sca-clean-fixture",
  version: "1.0.0",
};

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const fail = (message) => {
  console.error(`gen-vuln-lockfile: ${message}`);
  process.exit(1);
};

const refuse = (message) => {
  const err = new Error(message);
  err.code = "SCA_FIXTURE";
  throw err;
};

const insideRepo = (dir) => {
  const resolved = realpathSync(dir);
  const root = realpathSync(repoRoot);
  const rel = relative(root, resolved);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

export const writeLockfile = (dir, spec) => {
  if (insideRepo(dir)) refuse("refusing to write the fixture inside the repository — FAIL CLOSED");
  const installed = { version: spec.version };
  if (spec.resolved) installed.resolved = spec.resolved;
  if (spec.integrity) installed.integrity = spec.integrity;
  const lock = {
    name: "plerni-sca-fixture",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "plerni-sca-fixture",
        dependencies: { [spec.name]: spec.version },
      },
      [`node_modules/${spec.name}`]: installed,
    },
  };
  writeFileSync(join(dir, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
};

const invokedDirectly = () => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      clean: { type: "boolean", default: false },
    },
  });
  if (typeof values.dir !== "string" || values.dir.length === 0) fail("dir is required — FAIL CLOSED");
  const spec = values.clean ? CLEAN : VULN_SPEC;
  try {
    writeLockfile(values.dir, spec);
  } catch (err) {
    if (err && err.code === "SCA_FIXTURE") fail(err.message);
    if (err && err.code === "EEXIST") fail("package-lock.json already exists — FAIL CLOSED");
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) fail("dir is not a directory — FAIL CLOSED");
    fail("fixture was not written — FAIL CLOSED");
  }
  console.log(`gen-vuln-lockfile: wrote package-lock.json ${spec.name} ${spec.version}`);
}

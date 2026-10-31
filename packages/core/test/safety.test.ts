import path from "node:path";
import { describe, expect, it } from "vitest";
import { cloudSyncProvider, hubLocationWarnings, hubPaths } from "../src/index.js";

const home = path.resolve("/home/user");
const p = (...parts: string[]) => path.join(home, ...parts);

describe("cloudSyncProvider", () => {
  it.each([
    [p("OneDrive", "skillsym"), "OneDrive"],
    [p("OneDrive - Contoso", "Desktop", ".skillsym"), "OneDrive"],
    [p("Dropbox", "hub"), "Dropbox"],
    [p("Dropbox (Personal)", "hub"), "Dropbox"],
    [p("Google Drive", "hub"), "Google Drive"],
    [p("My Drive", "hub"), "Google Drive"],
    [p("Library", "Mobile Documents", "com~apple~CloudDocs", "hub"), "iCloud Drive"],
    [p("iCloudDrive", "hub"), "iCloud Drive"],
  ])("%s is inside %s", (dir, provider) => {
    expect(cloudSyncProvider(dir, {})).toBe(provider);
  });

  it("uses the roots OneDrive advertises in the environment (e.g. a redirected Desktop)", () => {
    const root = p("Sync", "Personal");
    expect(cloudSyncProvider(path.join(root, "Desktop", ".skillsym"), { OneDrive: root })).toBe("OneDrive");
  });

  it("does not flag ordinary folders", () => {
    expect(cloudSyncProvider(p(".skillsym"), { OneDrive: p("OneDrive") })).toBeNull();
    expect(cloudSyncProvider(p("projects", "drive-tools", "hub"), {})).toBeNull();
  });

  it("produces a warning that says what to do", () => {
    const [w] = hubLocationWarnings(hubPaths(p("OneDrive", "hub")), {});
    expect(w).toMatchObject({ code: "HUB_IN_CLOUD_FOLDER" });
    expect(w!.message).toContain("SKILLSYM_HOME");
  });
});

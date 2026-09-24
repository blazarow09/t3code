// @effect-diagnostics nodeBuiltinImport:off - tests need both posix and win32 path rules.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { mapCodeWorkspace } from "./CodeWorkspaceFile.ts";

const posix = NodePath.posix;
const win32 = NodePath.win32;

describe("mapCodeWorkspace", () => {
  it("roots the project at the file's folder and keeps only folders outside it", () => {
    const result = mapCodeWorkspace({
      filePath: "/srv/fivem/resources/tgg-scripts.code-workspace",
      path: posix,
      // Trailing commas and comments are valid in VS Code workspace files.
      text: `{
        // Scripts
        "folders": [
          { "name": "tgg-casino-tables", "path": "tgg-casino-tables", },
          { "path": "." },
          { "path": "../../../Projects/tebex-store" },
          { "path": "/opt/docs" },
          { "path": "/opt/docs/" },
        ],
        "settings": { "Lua.runtime.version": "Lua 5.4", },
      }`,
    });

    expect(result).toEqual({
      title: "tgg-scripts",
      workspaceRoot: "/srv/fivem/resources",
      additionalDirectories: ["/Projects/tebex-store", "/opt/docs"],
    });
  });

  it("resolves Windows folders with Windows path rules", () => {
    const result = mapCodeWorkspace({
      filePath: "D:\\FiveM\\resources\\[tgg]\\tgg.code-workspace",
      path: win32,
      text: `{ "folders": [
        { "path": "tgg-banking" },
        { "path": "../../../../Projects/tebex-store" },
        { "path": "C:/Users/me/Downloads/prp" },
        { "path": "d:\\\\fivem\\\\resources\\\\[tgg]\\\\tgg-misc" },
      ] }`,
    });

    expect(result).toEqual({
      title: "tgg",
      workspaceRoot: "D:\\FiveM\\resources\\[tgg]",
      additionalDirectories: ["D:\\Projects\\tebex-store", "C:\\Users\\me\\Downloads\\prp"],
    });
  });

  it("reports files that are not workspaces", () => {
    expect(mapCodeWorkspace({ filePath: "/a/b.code-workspace", path: posix, text: "{ nope" })).toBe(
      "the file is not valid JSON.",
    );
    expect(
      mapCodeWorkspace({
        filePath: "/a/b.code-workspace",
        path: posix,
        text: '{ "settings": {} }',
      }),
    ).toBe("the file has no folders list.");
  });
});

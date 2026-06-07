import test from "node:test";
import assert from "node:assert/strict";
import { extractGoogleDriveFileIds } from "../src/lib/googleDriveLinks";

test("extractGoogleDriveFileIds reads common Drive and Docs URLs", () => {
  const ids = extractGoogleDriveFileIds(
    [
      "https://drive.google.com/file/d/1Abc_DefGhijKlmnOPQrstuVwxyz12345/view?usp=sharing",
      "https://docs.google.com/spreadsheets/d/2Abc_DefGhijKlmnOPQrstuVwxyz12345/edit",
      "https://drive.google.com/open?id=3Abc_DefGhijKlmnOPQrstuVwxyz12345.",
    ].join(" "),
  );

  assert.deepEqual(ids, [
    "1Abc_DefGhijKlmnOPQrstuVwxyz12345",
    "2Abc_DefGhijKlmnOPQrstuVwxyz12345",
    "3Abc_DefGhijKlmnOPQrstuVwxyz12345",
  ]);
});

test("extractGoogleDriveFileIds ignores duplicate and non-Google URLs", () => {
  const ids = extractGoogleDriveFileIds(
    [
      "https://example.com/file/d/not-a-drive-file",
      "https://drive.google.com/file/d/1Abc_DefGhijKlmnOPQrstuVwxyz12345/view",
      "https://drive.google.com/file/d/1Abc_DefGhijKlmnOPQrstuVwxyz12345/view",
    ].join(" "),
  );

  assert.deepEqual(ids, ["1Abc_DefGhijKlmnOPQrstuVwxyz12345"]);
});

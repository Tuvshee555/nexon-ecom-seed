import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  MAX_PARSE_UPLOAD_DECODED_BYTES,
  parseUpload,
} from "../src/lib/fileParse";

test("parseUpload reads XLSX workbooks after dependency overrides", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Trips");
  sheet.addRow(["Маршрут", "Үнэ"]);
  sheet.addRow(["Улаанбаатар - Бээжин", 1200000]);

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await parseUpload({
    filename: "trips.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    dataBase64: buffer.toString("base64"),
  });

  assert.equal(parsed.label, "trips.xlsx");
  assert.equal(parsed.inline, null);
  assert.match(parsed.text, /Trips/);
  assert.match(parsed.text, /Улаанбаатар - Бээжин/);
  assert.match(parsed.text, /1200000/);
});

test("parseUpload reads legacy .xls workbooks via SheetJS", async () => {
  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Маршрут", "Үнэ"],
    ["Улаанбаатар - Сөүл", 950000],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Trips");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xls" });

  const parsed = await parseUpload({
    filename: "trips.xls",
    mimeType: "application/vnd.ms-excel",
    dataBase64: Buffer.from(buffer).toString("base64"),
  });

  assert.equal(parsed.inline, null);
  assert.match(parsed.text, /Улаанбаатар - Сөүл/);
  assert.match(parsed.text, /950000/);
});

test("parseUpload extracts text from .docx files", async () => {
  const { deflateRawSync } = await import("node:zlib");
  // Minimal valid DOCX: a ZIP whose word/document.xml holds two paragraphs.
  const documentXml =
    '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
    "<w:p><w:r><w:t>Бангкок аялал</w:t></w:r></w:p>" +
    "<w:p><w:r><w:t>Үнэ: 2400000</w:t></w:r></w:p>" +
    "</w:body></w:document>";

  const buildZip = (name: string, content: Buffer): Buffer => {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(content);
    const crc = (() => {
      let c = ~0;
      for (let i = 0; i < content.length; i += 1) {
        c ^= content[i];
        for (let k = 0; k < 8; k += 1) {
          c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
        }
      }
      return ~c >>> 0;
    })();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const localHeaderOffset = 0;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(localHeaderOffset, 42);

    const localPart = Buffer.concat([local, nameBuf, compressed]);
    const centralPart = Buffer.concat([central, nameBuf]);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(centralPart.length, 12);
    end.writeUInt32LE(localPart.length, 16);

    return Buffer.concat([localPart, centralPart, end]);
  };

  const docx = buildZip("word/document.xml", Buffer.from(documentXml, "utf8"));
  const parsed = await parseUpload({
    filename: "trip.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    dataBase64: docx.toString("base64"),
  });

  assert.equal(parsed.inline, null);
  assert.match(parsed.text, /Бангкок аялал/);
  assert.match(parsed.text, /2400000/);
});

test("parseUpload rejects oversized decoded uploads before parsing", async () => {
  const dataBase64 = Buffer.alloc(MAX_PARSE_UPLOAD_DECODED_BYTES + 1).toString(
    "base64",
  );

  await assert.rejects(
    () =>
      parseUpload({
        filename: "large.txt",
        mimeType: "text/plain",
        dataBase64,
      }),
    /too large/i,
  );
});

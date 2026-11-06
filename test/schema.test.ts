import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_SCHEMA } from '../src/extract.js';
import { ExtractionSchema, BillSchema, StatementSchema, LineSchema } from '../src/types.js';
import { billExtraction, statementExtraction } from './helpers.js';

type Obj = { required?: readonly string[]; properties?: Record<string, unknown> };

function parity(name: string, schema: Obj, zodKeys: string[]) {
  const props = Object.keys(schema.properties ?? {}).sort();
  assert.deepEqual(props, [...zodKeys].sort(), `${name}: properties differ from the validation schema`);
  assert.deepEqual([...(schema.required ?? [])].sort(), [...zodKeys].sort(), `${name}: every field must be required`);
}

test('the tool schema sent to Claude matches the schema used to validate its answer', () => {
  const top = TOOL_SCHEMA as unknown as Obj & { properties: Record<string, Obj & { items?: Obj }> };
  parity('top level', top, Object.keys(ExtractionSchema.shape));
  parity('bill', top.properties.bill as Obj, Object.keys(BillSchema.shape));
  parity('statement', top.properties.statement as Obj, Object.keys(StatementSchema.shape));
  const billProps = (top.properties.bill as Obj).properties as Record<string, Obj & { items?: Obj }>;
  parity('line', billProps.lines!.items as Obj, Object.keys(LineSchema.shape));
});

test('canned extractions used in tests are valid against the zod schema', () => {
  assert.ok(ExtractionSchema.safeParse(billExtraction()).success);
  assert.ok(ExtractionSchema.safeParse(statementExtraction()).success);
});

import { normaliseToolInput } from '../src/extract.js';

test('tool input repair: nested object sent as JSON text, and missing null fields', () => {
  const good = billExtraction();
  const broken = { ...good, bill: JSON.stringify(good.bill) } as Record<string, unknown>;
  delete broken.statement;
  delete broken.notes;
  const parsed = ExtractionSchema.safeParse(normaliseToolInput(broken));
  assert.ok(parsed.success);
  assert.equal(parsed.data.bill?.bill_number, good.bill?.bill_number);
  assert.equal(parsed.data.statement, null);
});

test('tool input repair never invents a bill from text that is not JSON', () => {
  const broken = { ...billExtraction(), bill: 'Invoice 123 for 160 dollars' };
  assert.equal(ExtractionSchema.safeParse(normaliseToolInput(broken)).success, false);
});

test('tool input repair: a nullable field left out is read as not shown on the document', () => {
  const good = billExtraction();
  const broken = JSON.parse(JSON.stringify(good)) as { bill: Record<string, unknown> };
  delete broken.bill.subtotal_ex_gst;
  delete (broken.bill.lines as Array<Record<string, unknown>>)[0]!.unit_price;
  const parsed = ExtractionSchema.safeParse(normaliseToolInput(broken));
  assert.ok(parsed.success);
  assert.equal(parsed.data.bill?.subtotal_ex_gst, null);
});

test('tool input repair does not fill in a missing required amount', () => {
  const broken = JSON.parse(JSON.stringify(billExtraction())) as { bill: { lines: Array<Record<string, unknown>> } };
  delete broken.bill.lines[0]!.line_amount;
  assert.equal(ExtractionSchema.safeParse(normaliseToolInput(broken)).success, false);
});

test('tool input repair: bill text followed by stray fields is read up to the end of the bill object', () => {
  const good = billExtraction();
  const text = JSON.stringify(good.bill) + ', "statement": null, "notes": null}';
  const broken = { ...good, bill: text } as Record<string, unknown>;
  delete broken.statement;
  delete broken.notes;
  const parsed = ExtractionSchema.safeParse(normaliseToolInput(broken));
  assert.ok(parsed.success);
  assert.equal(parsed.data.bill?.total_inc_gst, good.bill?.total_inc_gst);
});

test('tool input repair: a cut-off bill text is rejected, never guessed', () => {
  const good = billExtraction();
  const text = JSON.stringify(good.bill).slice(0, 120);
  assert.equal(ExtractionSchema.safeParse(normaliseToolInput({ ...good, bill: text })).success, false);
});

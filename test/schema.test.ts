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

test('a bill sent as text that is missing its last closing brace is repaired, and an incomplete one still fails', async () => {
  const { normaliseToolInput, parseJsonObjectText } = await import('../src/extract.js');
  const good = billExtraction();
  const full = JSON.stringify(good.bill);
  const broken = full.slice(0, -1); // drop the final "}"
  assert.ok(!broken.endsWith('}'));
  const repaired = normaliseToolInput({ ...good, bill: broken }) as { bill: unknown };
  assert.deepEqual(repaired.bill, JSON.parse(full));
  assert.equal(ExtractionSchema.safeParse(repaired).success, true);

  // Cut in the middle of the record: must not be accepted.
  const cut = full.slice(0, Math.floor(full.length / 2));
  const r2 = normaliseToolInput({ ...good, bill: cut }) as unknown;
  assert.equal(ExtractionSchema.safeParse(r2).success, false);
  assert.equal(parseJsonObjectText('{"a":1,"b":"unfinished'), undefined);
});

test('a bill that arrives without its totals is flagged, never given null totals; the totals are merged in from a second look', async () => {
  const { billMissingTotals, mergeTotals } = await import('../src/extract.js');
  const good = billExtraction();
  const noTotals = JSON.parse(JSON.stringify(good)) as { bill: Record<string, unknown> };
  delete noTotals.bill.total_gst;
  delete noTotals.bill.total_inc_gst;
  const n = normaliseToolInput(noTotals);
  assert.equal(billMissingTotals(n), true);
  assert.equal(ExtractionSchema.safeParse(n).success, false);
  const merged = mergeTotals(n, { subtotal_ex_gst: good.bill!.subtotal_ex_gst, total_gst: good.bill!.total_gst, total_inc_gst: good.bill!.total_inc_gst });
  assert.equal(billMissingTotals(merged), false);
  assert.equal(ExtractionSchema.safeParse(merged).success, true);
  // An explicit null from the model is a real answer, not a gap.
  const explicitNull = JSON.parse(JSON.stringify(good)) as { bill: Record<string, unknown> };
  explicitNull.bill.total_gst = null;
  assert.equal(billMissingTotals(normaliseToolInput(explicitNull)), false);
});

test('the order-date rule is added to the instructions only for the suppliers named in the config', async () => {
  const { buildSystemPrompt } = await import('../src/extract.js');
  assert.ok(!buildSystemPrompt([]).includes('ORDER DATE'));
  const p = buildSystemPrompt(['Natoora']);
  assert.ok(p.includes('"Natoora"') && p.includes('ORDER DATE') && p.includes('every other supplier'));
});

test('payment-ref suppliers get an extra prompt rule, others do not', async () => {
  const { buildSystemPrompt } = await import('../src/extract.js');
  assert.ok(buildSystemPrompt([], ['Microsoft']).includes('Payment Ref'));
  assert.ok(!buildSystemPrompt([], []).includes('Payment Ref'));
  assert.ok(buildSystemPrompt(['Natoora'], ['Microsoft']).includes('ORDER DATE'));
});

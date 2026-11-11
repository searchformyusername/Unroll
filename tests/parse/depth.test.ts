import { describe, expect, it } from 'vitest';
import { parse, ParseError } from '../../src/parse/index.ts';
import { assertNestingDepth, MAX_NESTING_DEPTH, parseArgs } from '../../src/parse/util.ts';
import { analyze } from '../../src/analyze/index.ts';

// Construct JSON text directly: the hostile control must not crash the test's JSON.stringify.
const nestedObject = (depth: number) => '{"child":'.repeat(depth) + '"leaf"' + '}'.repeat(depth);
const nestedArray = (depth: number) => '['.repeat(depth) + '0' + ']'.repeat(depth);
const toolDocument = (argumentsJson: string) => '{"messages":[{"role":"assistant","tool_calls":[{"id":"call","function":{"name":"inspect","arguments":' + argumentsJson + '}}]}]}';
const capture = (run: () => unknown) => {
  try { run(); } catch (error) { return error; }
  throw new Error('Expected the depth guard to reject this input');
};

describe('explicit trajectory nesting limit', () => {
  it('allows exactly 200 object or array levels, and rejects 201 without recursion', () => {
    for (const nested of [nestedObject, nestedArray]) {
      expect(() => assertNestingDepth(JSON.parse(nested(MAX_NESTING_DEPTH)))) .not.toThrow();
      const error = capture(() => assertNestingDepth(JSON.parse(nested(MAX_NESTING_DEPTH + 1))));
      expect(error).toBeInstanceOf(ParseError);
      expect(error).toMatchObject({code: 'too_deep'});
      expect((error as Error).message).toMatch(/200.*Flatten/);
    }
  });
  it('rejects the formerly accepted 100 KB deeply nested tool input before analysis', () => {
    const text = toolDocument(nestedObject(10_000));
    expect(text.length).toBeLessThan(110_000);
    expect(capture(() => parse(text))).toMatchObject({name: 'ParseError', code: 'too_deep'});
  });
  it('validates document metadata too, not only recognized message or argument fields', () => {
    const text = '{"messages":[{"role":"user","content":"hello"}],"extra":' + nestedArray(200) + '}';
    expect(capture(() => parse(text))).toMatchObject({code: 'too_deep'});
  });
  it('rejects a deeply nested JSONL record instead of skipping it as malformed data', () => {
    const input = JSON.stringify({type: 'session_meta', payload: {id: 'synthetic'}}) + '\n' +
      '{"type":"response_item","payload":{"type":"function_call","name":"inspect","call_id":"c","arguments":' + nestedObject(200) + '}}\n';
    const error = capture(() => parse(input));
    expect(error).toMatchObject({code: 'too_deep'});
    expect((error as Error).message).toContain('line 2');
  });
  it('validates JSONL arrays even if the record would otherwise be skipped as a non-object', () => {
    const input = '{"role":"user","content":"hello"}\n' + nestedArray(201) + '\n';
    expect(capture(() => parse(input))).toMatchObject({code: 'too_deep'});
  });
  it('checks string-encoded arguments after decoding, without swallowing the guard error', () => {
    const encoded = JSON.stringify(nestedObject(201));
    expect(capture(() => parse(toolDocument(encoded)))).toMatchObject({code: 'too_deep'});
    expect(capture(() => parseArgs(nestedArray(201)))).toMatchObject({code: 'too_deep'});
  });
  it('preserves malformed argument strings as text and accepts a healthy moderately nested control', () => {
    expect(parseArgs('{broken')).toBe('{broken');
    const nested = nestedObject(60);
    for (const argument of [nested, JSON.stringify(nested)]) {
      const result = parse(toolDocument(argument));
      expect(result.session.events).toHaveLength(1);
      expect(() => analyze(result.session)).not.toThrow();
      let value = result.session.events[0].input as {child: unknown};
      for (let i = 0; i < 59; i++) value = value.child as {child: unknown};
      expect(value.child).toBe('leaf');
    }
  });
  it('accepts a wide shallow collection rather than mistaking node count for depth', () => {
    const result = parse(JSON.stringify({messages: [{role: 'user', content: 'wide control'}], extra: Array.from({length: 25_000}, (_, i) => ({value: i}))}));
    expect(result.session.events[0].text).toBe('wide control');
  });
});

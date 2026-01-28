import { describe, expect, it } from 'vitest';
import { ReasoningProcessor } from './reasoningProcessor';

describe('ReasoningProcessor', () => {
    it('emits a reasoning message for plain deltas', () => {
        const outputs: any[] = [];
        const processor = new ReasoningProcessor((msg) => outputs.push(msg));

        processor.processDelta('hello');
        processor.flushCompleted();

        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatchObject({ type: 'reasoning', message: 'hello' });
    });

    it('does not treat **Title** markdown as a tool call section', () => {
        const outputs: any[] = [];
        const processor = new ReasoningProcessor((msg) => outputs.push(msg));

        processor.processDelta('**Title**\nSome details');
        processor.flushCompleted();

        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatchObject({ type: 'reasoning' });
        expect(String(outputs[0].message)).toContain('**Title**');
    });

    it('treats **[Title]** sections as CodexReasoning tool calls', () => {
        const outputs: any[] = [];
        const processor = new ReasoningProcessor((msg) => outputs.push(msg));

        processor.processDelta('**[Step]** hello');
        processor.flushCompleted();

        expect(outputs).toHaveLength(2);
        expect(outputs[0]).toMatchObject({
            type: 'tool-call',
            name: 'CodexReasoning',
            input: { title: 'Step' }
        });
        expect(outputs[1]).toMatchObject({
            type: 'tool-call-result',
            callId: outputs[0].callId,
            output: { content: 'hello', status: 'completed' }
        });
    });

    it('inserts a separator on section break for non-tool reasoning', () => {
        const outputs: any[] = [];
        const processor = new ReasoningProcessor((msg) => outputs.push(msg));

        processor.processDelta('first');
        processor.handleSectionBreak();
        processor.processDelta('second');
        processor.flushCompleted();

        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatchObject({ type: 'reasoning', message: 'first\n\nsecond' });
    });

    it('flushes the current tool section on section break', () => {
        const outputs: any[] = [];
        const processor = new ReasoningProcessor((msg) => outputs.push(msg));

        processor.processDelta('**[One]** a');
        processor.handleSectionBreak();
        processor.processDelta('**[Two]** b');
        processor.flushCompleted();

        const calls = outputs.filter((o) => o?.type === 'tool-call');
        const results = outputs.filter((o) => o?.type === 'tool-call-result');

        expect(calls).toHaveLength(2);
        expect(results).toHaveLength(2);
        expect(calls[0]).toMatchObject({ name: 'CodexReasoning', input: { title: 'One' } });
        expect(calls[1]).toMatchObject({ name: 'CodexReasoning', input: { title: 'Two' } });
        expect(results[0]).toMatchObject({ callId: calls[0].callId, output: { content: 'a', status: 'completed' } });
        expect(results[1]).toMatchObject({ callId: calls[1].callId, output: { content: 'b', status: 'completed' } });
    });
});


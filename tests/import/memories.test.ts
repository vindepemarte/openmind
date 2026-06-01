import test from 'node:test';
import assert from 'node:assert/strict';

import { buildImportPlan, chunkLargeText, parseCsvRows } from '../../src/import/memories';

test('parseCsvRows handles quoted commas and escaped quotes', () => {
    const rows = parseCsvRows('content,source\n"hello, world","chatgpt"\n"say ""hi""",notes\n');
    assert.deepEqual(rows, [
        ['content', 'source'],
        ['hello, world', 'chatgpt'],
        ['say "hi"', 'notes']
    ]);
});

test('buildImportPlan guesses CSV mapping and extracts optional fields', () => {
    const csv = [
        'content,source,type,tags',
        '"Ship pricing page",sales,action,"launch, pricing"',
        '"Review duplicated notes",ops,decision,"cleanup"',
    ].join('\n');

    const plan = buildImportPlan('pipeline.csv', csv);

    assert.equal(plan.detectedType, 'csv');
    assert.deepEqual(plan.headers, ['content', 'source', 'type', 'tags']);
    assert.equal(plan.mapping?.contentColumn, 'content');
    assert.equal(plan.items.length, 2);
    assert.deepEqual(plan.items[0], {
        content: 'Ship pricing page',
        source: 'sales',
        thoughtType: 'action',
        tags: ['launch', 'pricing']
    });
});

test('buildImportPlan supports remapping custom CSV headers', () => {
    const csv = [
        'body,origin,labels',
        '"First note",telegram,"urgent|founder"',
    ].join('\n');

    const plan = buildImportPlan('custom.csv', csv, {
        contentColumn: 'body',
        sourceColumn: 'origin',
        tagsColumn: 'labels'
    });

    assert.equal(plan.items.length, 1);
    assert.deepEqual(plan.items[0], {
        content: 'First note',
        source: 'telegram',
        thoughtType: undefined,
        tags: ['urgent', 'founder']
    });
});

test('buildImportPlan falls back to text chunking for plain text files', () => {
    const plan = buildImportPlan('notes.txt', 'One paragraph.\n\nSecond paragraph.');
    assert.equal(plan.detectedType, 'text');
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].source, 'upload-notes.txt');
    assert.match(plan.items[0].content, /One paragraph/);
    assert.match(plan.items[0].content, /Second paragraph/);
});

test('chunkLargeText splits oversized single-paragraph content into bounded chunks', () => {
    const longWord = 'x'.repeat(4500);
    const chunks = chunkLargeText(longWord, 2000);

    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].length, 2000);
    assert.equal(chunks[1].length, 2000);
    assert.equal(chunks[2].length, 500);
    assert.ok(chunks.every(chunk => chunk.length <= 2000));
});

test('buildImportPlan chunks oversized CSV content rows while preserving metadata', () => {
    const longContent = 'x'.repeat(4500);
    const csv = [
        'content,source,type,tags',
        `"${longContent}",slack,insight,"alpha;beta"`,
    ].join('\n');

    const plan = buildImportPlan('large.csv', csv);

    assert.equal(plan.detectedType, 'csv');
    assert.equal(plan.items.length, 3);
    assert.ok(plan.items.every(item => item.content.length <= 2000));
    assert.ok(plan.items.every(item => item.source === 'slack'));
    assert.ok(plan.items.every(item => item.thoughtType === 'insight'));
    assert.ok(plan.items.every(item => item.tags.join(',') === 'alpha,beta'));
});

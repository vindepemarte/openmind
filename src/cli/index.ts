#!/usr/bin/env node

import { captureThought } from '../processing/pipeline';

async function main() {
    const args = process.argv.slice(2);
    const content = args.join(' ');

    if (!content) {
        console.error('Usage: npx @vindepemarte/openmind "Your thought here"');
        process.exit(1);
    }

    try {
        console.log('Capturing thought...');
        const result = await captureThought(content, { source: 'cli' });

        console.log('\nSuccess!');
        console.log(`ID: ${result.id}`);
        if (result.status === 'duplicate') {
            console.log('Note: This thought was already in your brain (duplicate detected).');
        } else if (result.metadata) {
            console.log(`Type: ${result.metadata.type}`);
            if (result.metadata.topics.length > 0) console.log(`Topics: ${result.metadata.topics.join(', ')}`);
            if (result.metadata.people.length > 0) console.log(`People: ${result.metadata.people.join(', ')}`);
            if (result.metadata.action_items.length > 0) console.log(`Action Items: ${result.metadata.action_items.join(' | ')}`);
            console.log(`Summary: ${result.metadata.summary}`);
        }
    } catch (error) {
        console.error('\nFailed to capture thought:', error);
        process.exit(1);
    } finally {
        process.exit(0);
    }
}

main();

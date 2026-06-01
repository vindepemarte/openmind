import test from 'node:test';
import assert from 'node:assert/strict';

import { buildKpiSuggestions, estimateTimeSavedMinutes } from '../../src/analytics/kpis';

test('estimateTimeSavedMinutes combines duplicate, reminder, and risk savings', () => {
    const minutes = estimateTimeSavedMinutes({
        duplicatesPrevented: 3,
        totalReminders: 10,
        completedReminders: 4,
        reminderCompletionRate: 40,
        unresolvedRiskCount: 2
    });

    assert.equal(minutes, 34);
});

test('buildKpiSuggestions returns actionable suggestions when metrics are weak', () => {
    const suggestions = buildKpiSuggestions({
        duplicatesPrevented: 5,
        totalReminders: 8,
        completedReminders: 2,
        reminderCompletionRate: 25,
        unresolvedRiskCount: 3
    });

    assert.equal(suggestions.length, 3);
    assert.match(suggestions[0], /unresolved risks/i);
});

test('buildKpiSuggestions returns a healthy-state fallback when metrics are clean', () => {
    const suggestions = buildKpiSuggestions({
        duplicatesPrevented: 0,
        totalReminders: 0,
        completedReminders: 0,
        reminderCompletionRate: 0,
        unresolvedRiskCount: 0
    });

    assert.equal(suggestions.length, 1);
    assert.match(suggestions[0], /workflow is clean/i);
});

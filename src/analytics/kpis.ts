export interface KpiSnapshot {
    duplicatesPrevented: number;
    totalReminders: number;
    completedReminders: number;
    reminderCompletionRate: number;
    unresolvedRiskCount: number;
}

export function estimateTimeSavedMinutes(snapshot: KpiSnapshot): number {
    const duplicateMinutes = snapshot.duplicatesPrevented * 2;
    const reminderMinutes = snapshot.completedReminders * 6;
    const riskMinutes = snapshot.unresolvedRiskCount > 0 ? Math.min(snapshot.unresolvedRiskCount * 2, 20) : 0;

    return duplicateMinutes + reminderMinutes + riskMinutes;
}

export function buildKpiSuggestions(snapshot: KpiSnapshot): string[] {
    const suggestions: string[] = [];

    if (snapshot.unresolvedRiskCount > 0) {
        suggestions.push(`${snapshot.unresolvedRiskCount} unresolved risks need review. Clear or defer them from the Action Queue.`);
    }

    if (snapshot.totalReminders > 0 && snapshot.reminderCompletionRate < 50) {
        suggestions.push(`Reminder completion is ${snapshot.reminderCompletionRate}%. Close a few high-signal tasks to improve follow-through.`);
    }

    if (snapshot.duplicatesPrevented > 0) {
        suggestions.push(`${snapshot.duplicatesPrevented} duplicate entries were prevented. Keep imports running through preview-first mode to preserve that gain.`);
    }

    if (suggestions.length === 0) {
        suggestions.push('Your memory workflow is clean right now. Keep importing through preview and close reminders as they are resolved.');
    }

    return suggestions;
}

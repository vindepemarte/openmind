const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const PASSWORD_POLICY = {
    minLength: 10,
    requireLowercase: true,
    requireUppercase: true,
    requireNumber: true,
};

export function normalizeUsername(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.trim();
}

export function validateUsername(username: string): string | null {
    if (!username) return 'username is required';
    if (username.length < 3 || username.length > 64) {
        return 'username must be between 3 and 64 characters';
    }
    if (!USERNAME_PATTERN.test(username)) {
        return 'username may only contain letters, numbers, dots, underscores, and hyphens';
    }
    return null;
}

export function validatePasswordPolicy(password: string): string | null {
    if (!password) return 'password is required';
    if (password.length < PASSWORD_POLICY.minLength) {
        return `password must be at least ${PASSWORD_POLICY.minLength} characters`;
    }
    if (PASSWORD_POLICY.requireLowercase && !/[a-z]/.test(password)) {
        return 'password must include at least one lowercase letter';
    }
    if (PASSWORD_POLICY.requireUppercase && !/[A-Z]/.test(password)) {
        return 'password must include at least one uppercase letter';
    }
    if (PASSWORD_POLICY.requireNumber && !/[0-9]/.test(password)) {
        return 'password must include at least one number';
    }
    return null;
}

export function passwordPolicySummary(): string {
    return `Password must be at least ${PASSWORD_POLICY.minLength} characters and include uppercase, lowercase, and a number.`;
}

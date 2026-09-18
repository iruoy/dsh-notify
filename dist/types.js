export const KINDS = ['completed', 'error', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'approval'];
export const LABELS = {
    completed: 'Task completed', error: 'Task failed', aborted: 'Task aborted', blocked: 'Task blocked',
    'max-tokens': 'Token limit reached', interrupted: 'Task interrupted', approval: 'Approval requested',
};
export const API = '/api/dsh-notify';

// Test stub for js/store/github.js — no network.
export class GitHubConflictError extends Error {}

export class GitHubClient {
  constructor({ owner, repo, branch = 'main', token }) {
    Object.assign(this, { owner, repo, branch, token });
  }
  async checkAccess() {
    await new Promise((r) => setTimeout(r, 200));
    if (!this.token.startsWith('github_pat_')) return { ok: false, repoPrivate: false, canPush: false, message: '토큰이 올바르지 않습니다. (401)' };
    if (this.repo === 'public-repo') return { ok: true, repoPrivate: false, canPush: true, message: '' };
    if (this.repo === 'readonly') return { ok: true, repoPrivate: true, canPush: false, message: '' };
    return { ok: true, repoPrivate: true, canPush: true, message: '' };
  }
  async getHead() { return { commitSha: 'c0', treeSha: 't0' }; }
  async listTree() { return new Map(); }
  async readBlob() { return new Uint8Array(); }
  async commit() { return { commitSha: 'c1', treeSha: 't1' }; }
}

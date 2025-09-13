import { WebChatSession } from './WebChatSession';

export class WebChatManager {
  private sessions: Record<string, WebChatSession> = {};

  getSession(ip: string): WebChatSession {
    if (!this.sessions[ip]) {
      this.sessions[ip] = new WebChatSession();
    }
    return this.sessions[ip];
  }

  resetSession(ip: string) {
    if (this.sessions[ip]) {
      this.sessions[ip].clear();
    }
  }
}

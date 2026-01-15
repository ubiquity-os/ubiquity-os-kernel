interface SingleLog {
  subhosterId: string;
  deploymentId: string;
  isolateId: string;
  region: string;
  level: string;
  timestamp: string;
  message: string;
}

export interface LogsResponse {
  logs: SingleLog[];
  nextCursor: null | string;
}

import { handleRealtimeSessionRequest } from "../server/realtimeSession.js";

export default {
  fetch(request: Request): Promise<Response> {
    return handleRealtimeSessionRequest(request);
  }
};

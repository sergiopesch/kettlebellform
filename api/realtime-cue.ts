import { handleRealtimeCueRequest } from "../server/realtimeCue.js";

export default {
  fetch(request: Request): Promise<Response> {
    return handleRealtimeCueRequest(request);
  }
};

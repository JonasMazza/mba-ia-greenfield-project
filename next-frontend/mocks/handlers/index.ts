import { handlers as authHandlers } from "./auth";
import { handlers as seedHandlers } from "./_seed";
import { handlers as storageHandlers } from "./storage";
import { handlers as videosHandlers } from "./videos";

export const handlers = [...authHandlers, ...videosHandlers, ...storageHandlers, ...seedHandlers];

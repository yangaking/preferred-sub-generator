import { handleVvhan } from "../src/api/vvhan.js";

export async function onRequestGet({ env }) {
  return handleVvhan(env);
}

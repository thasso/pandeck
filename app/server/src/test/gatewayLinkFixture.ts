/** A disposable server-link owner for Task-1383's process evidence test.
 * No server startup: only the socket link and fake profiles in DATA_DIR.
 */
import { startGatewayLink } from "../gatewayLink.ts";

const options = JSON.parse(process.argv[2]!) as {
  stateDir: string;
  socketPath: string;
  port: number;
  profileId: string;
};
const link = startGatewayLink({ ...options, log: () => {} });
if (!(await link.ready))
  throw new Error("The fixture link did not become ready.");
const holdId = await link.acquireLoginHold(options.profileId);
const server = await link.serverAccess(options.profileId);
const external = await link.grantEngineLease({
  workerId: "ext-1",
  profileId: options.profileId,
});
console.log(`ready ${JSON.stringify({ holdId, server, external })}`);
setInterval(() => {}, 1000);

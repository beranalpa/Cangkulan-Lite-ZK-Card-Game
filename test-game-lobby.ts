import { rpc, xdr } from '@stellar/stellar-sdk';
const url = 'https://soroban-testnet.stellar.org';
const server = new rpc.Server(url);
const CANGKULAN_CONTRACT = 'CCOMMIIORXZOAV3PJ32UUMTWCMWOAIT4RC4RLQFJW4XU6RNO3IPZKK65';
const RPC_SCAN_WINDOW = 10000;

async function testFetch() {
  const latestLedger = await server.getLatestLedger();
  const startLedger = Math.max(latestLedger.sequence - 17280, 1);
  const chainTip = latestLedger.sequence;
  const topicSymbol = 'ev_game_started';

  let currentStart = startLedger;
  let cursor;
  for (let page = 0; page < 30; page++) {
    try {
      const params: any = {
        filters: [{
          type: 'contract',
          contractIds: [CANGKULAN_CONTRACT],
          topics: [[xdr.ScVal.scvSymbol(topicSymbol).toXDR('base64')]],
        }],
        limit: 100,
      };
      if (cursor) params.cursor = cursor;
      else params.startLedger = currentStart;

      console.log(`Fetching from ${params.startLedger || params.cursor}...`);
      const resp = await server.getEvents(params);
      console.log(`Got ${resp.events?.length || 0} events`);

      if (!resp.events || resp.events.length === 0) {
        currentStart += RPC_SCAN_WINDOW;
        cursor = undefined;
        if (currentStart < chainTip) continue;
        break;
      }

      console.log(`First event ledger: ${resp.events[0].ledger}, last: ${resp.events[resp.events.length - 1].ledger}`);

      if (resp.events.length >= 100) {
        cursor = resp.events[resp.events.length - 1].id;
        continue;
      }

      const lastLedger = resp.events[resp.events.length - 1].ledger;
      const nextStart = Math.max(lastLedger + 1, currentStart + RPC_SCAN_WINDOW);
      cursor = undefined;
      if (nextStart < chainTip) {
        currentStart = nextStart;
        continue;
      }
      break;
    } catch (err: any) {
      console.error("Error fetching:", err.response?.data || err.message);
      break;
    }
  }
}
testFetch();

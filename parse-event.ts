import { rpc, xdr, Address } from '@stellar/stellar-sdk';
const url = 'https://soroban-testnet.stellar.org';
const server = new rpc.Server(url);
const CANGKULAN_CONTRACT = 'CCOMMIIORXZOAV3PJ32UUMTWCMWOAIT4RC4RLQFJW4XU6RNO3IPZKK65';

async function testFetch() {
  const latestLedger = await server.getLatestLedger();
  const startLedger = Math.max(latestLedger.sequence - 5000, 1);
  const resp = await server.getEvents({
    startLedger,
    filters: [{
      type: 'contract',
      contractIds: [CANGKULAN_CONTRACT],
      topics: [[xdr.ScVal.scvSymbol('ev_game_started').toXDR('base64')]],
    }],
    limit: 1,
  });
  
  if (resp.events && resp.events.length > 0) {
    const ev = resp.events[0];
    const data = ev.value;
    console.log("data switch name:", data.switch().name);
    
    // BUT what about the event structure?
    // Let's inspect data: Wait, EvGameStarted is a struct, not a map!
    // In soroban: #[contractevent] pub struct EvGameStarted { pub session_id: u32, pub player1: Address, pub player2: Address }
    // How is a struct formatted in events? Usually it's an scvVec of values!
    // Or is it scvMap? No, rust structs without #[contracttype] might not be exported as map, but events with #[contractevent] follow a specific format.
    // Let's log the XDR representation!
    console.log(JSON.stringify(data, (k,v) => typeof v === 'bigint' ? v.toString() : v, 2));
    if (data.switch().name === 'scvVec') {
      console.log("Vec items:", data.vec()?.map(v => v.switch().name));
    }
  }
}
testFetch();

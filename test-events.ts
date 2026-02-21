import { rpc } from '@stellar/stellar-sdk';
const url = 'https://soroban-testnet.stellar.org';
const server = new rpc.Server(url);
async function run() {
  const latest = await server.getLatestLedger();
  const resp = await server.getEvents({
    startLedger: latest.sequence - 500,
    filters: [
      {
        type: 'contract',
        contractIds: ['CCOMMIIORXZOAV3PJ32UUMTWCMWOAIT4RC4RLQFJW4XU6RNO3IPZKK65']
      }
    ],
    limit: 10
  });
  console.log(resp.events.map(e => e.topic.map(t => {
    try {
      return t.sym().toString();
    } catch {
      return t.switch().name;
    }
  })));
}
run();

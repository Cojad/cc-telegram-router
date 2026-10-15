// A worker as the router sees it: connects with the conversation folder as
// project dir, records every delivery to FAKE_STATE.deliveries, acks it.

import { appendFileSync } from 'fs'
import { connectRouter } from '../../../plugin/client'

const dir = process.argv[2]!
const client = connectRouter({
  socketPath: process.env.FAKE_SOCKET!,
  hello: { t: 'hello', project_dir: dir, pid: process.pid },
  onMessage(m) {
    if (m.t !== 'deliver') return
    appendFileSync(process.env.FAKE_STATE + '.deliveries', JSON.stringify({ dir, pid: process.pid, qid: m.qid, content: m.params.content }) + '\n')
    client.send({ t: 'ack', qid: m.qid })
  },
})
process.on('SIGTERM', () => { client.close(); setTimeout(() => process.exit(0), 50) })
setInterval(() => {}, 1 << 30)

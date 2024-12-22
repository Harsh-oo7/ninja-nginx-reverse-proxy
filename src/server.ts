import http from 'node:http'
import { ConfigSchemaType, rootConfigSchema } from "./config-schema";
import cluster, { Worker } from 'node:cluster'
import { workerMessageReplySchema, WorkerMessageReplyType, workerMessageSchema, WorkerMessageType } from './server-schema';

interface CreateServerConfig {
    port: number;
    workerCount: number;
    config: ConfigSchemaType;
}

export async function createServer(config: CreateServerConfig) {
    const { port, workerCount } = config;

    const WORKER_POOL : Worker[] = []

    if(cluster.isPrimary) {
        console.log('Master process is up.');

        for(let i=0;i<workerCount;i++) {
            const w = cluster.fork({ config: JSON.stringify(config.config) });
            WORKER_POOL.push(w)
            console.log("Worker node spinned", i)
        }

        const server = http.createServer((req, res) => {
            // choosing a random worker to forward the request to
            const index = Math.floor(Math.random() * WORKER_POOL.length)
            const worker: Worker = WORKER_POOL[index]

            if(!worker) throw new Error('No worker available')

            const payload: WorkerMessageType = {
                requestType: 'HTTP',
                headers: req.headers,
                body: null,
                url: req.url as string
            }
            worker.send(JSON.stringify(payload))

            worker.on('message', async (workerReply: string) => {
                const reply = await workerMessageReplySchema.parseAsync(JSON.parse(workerReply));
                // console.log('Master received reply', reply)
                if(reply.errorCode) {
                    res.statusCode = parseInt(reply.errorCode);
                    res.end(reply.error)
                    return;
                }
                else {
                    res.end(reply.data)
                    return;
                }
            })
        })

        server.listen(port, () => {
            console.log('Server is up on port', port)
        })
    }
    else {
        console.log('Worker process is up.');
        const config = await rootConfigSchema.parseAsync(JSON.parse(process.env.config as string))
        // console.log(config)

        process.on('message', async (message: string) => {
            console.log('Worker received message', message) 
            const messageValidated = await workerMessageSchema.parseAsync(JSON.parse(message));

            // console.log("messageValidated", messageValidated)
            const requestURL = messageValidated.url;
            const rule = config.server.rules.find(rule => requestURL.startsWith(rule.path));

            // console.log("rule", rule)
            if(!rule) {
                console.log('No rule found for', requestURL)
                const reply: WorkerMessageReplyType =  {
                    errorCode: '404',
                    error: 'No rule found'
                }
                if(process.send) process.send(JSON.stringify(reply));
                return;
            }

            const upstreamID = rule.upstreams[0];
            const upstream = config.server.upstreams.find(upstream => upstream.id === upstreamID);
            if(!upstream) {
                console.log('No upstream found for', upstream)
                const reply: WorkerMessageReplyType =  {
                    errorCode: '500',
                    error: 'No upstream found'
                }
                if(process.send) process.send(JSON.stringify(reply));
                return;
            }

            // console.log({
            //     host: upstream.url,
            //     path: requestURL
            // })

            const request = http.request({ host: upstream.url, path: requestURL, method: 'GET' }, (proxyRes) => {
                let body = '';

                proxyRes.on('data', (chunk) => {
                    body += chunk;
                })

                proxyRes.on('end', () => {
                    const reply: WorkerMessageReplyType =  {
                        data: body,
                    }
                    if(process.send) process.send(JSON.stringify(reply));
                })
            })
            request.end();
        })
    }
}
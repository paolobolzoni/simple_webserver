'use strict';
process.chdir(__dirname);

const url = require('url');
const fs = require('fs');
const path = require('path');
const settings = require('toml').parse(fs.readFileSync('./server.toml', { encoding:'utf8' }));


function r(no, req, res) {
    const page = `<!doctype html>\n<html lang="en"> <head> <meta charset="utf-8"> <title>${no}</title> </head> <body> <h1>${no}</h1> </body> </html>\n`;
    res.statusCode = no;
    res.end(page);
}


function npObj(obj) {
    let r = Object.create(null);
    if (!!obj)
        for (let k of Object.keys(obj)) {
            r[k] = obj[k];
        }
    return r;
}


const get_functions = (new function(client_dir) {
    const mime_types = {
      '.html': 'text/html',
      '.txt': 'text/plain',
      '.css': 'text/css',
      '.js': 'text/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.ico': 'image/vnd.microsoft.icon',
      '.woff2': 'font/woff2'
    }

    this.static_content = function(req, res) {
        function connect_stream(exist) {
            if (!exist || fs.statSync(pathname).isDirectory()) {
                return r(404, req, res);
            }

            const stream = fs.createReadStream(pathname, { emitClose: true });
            stream.on('open', function() {
                res.setHeader('Content-type', mime);
            });
            stream.on('data', function (chunk) {
                res.write(chunk);
            });
            stream.on('end', function() {
                res.end();
            });
            stream.on('error', function(error) {
                console.trace();
                console.error(error);
                return r(500, req, res);
            });
        }

        const parsedUrl = url.parse(req.url);
        let pathname = `.${parsedUrl.pathname}`;
        pathname = path.join(client_dir, pathname);

        const mime = mime_types[path.parse(pathname).ext] || 'application/octet-stream';
        fs.exists(pathname, connect_stream);
    }
}(settings.server.client_dir));


const ws_functions = (new function(){
    this.echo = function(connection, request) {
        function echo_back(message) {
            if (message.type === 'utf8') {
                connection.sendUTF(message.utf8Data);
            }
        }
        function close() {}
        connection.on('message', echo_back);
        connection.on('close', close);
    }
}());


const http_dispatcher = npObj({
    GET: get_functions.static_content
});

const ws_dispatcher = npObj({
    check_origin: (function(fqdn, port){
        if (!!fqdn) {
            return function(origin) {
                console.log(`WS connection from ${origin}`);
                return origin === 'https://' + fqdn + ':' + port;
            }
        } else {
            return function(origin) {
                console.log(`WS connection from ${origin}`);
                return true;
            }
        }
    }(settings.https.enabled && settings.https.fqdn, settings.server.port)),
    '/echo/': ws_functions.echo
});



const server = (new function(settings, methods) {
    const the_website = (function(credentials, methods) {
        function dispatch(req, res) {
            console.log(`${req.method} ${req.url}`);

            if (methods[ req.method ] != null) {
                return methods[ req.method ](req, res);
            }
            return r(405, req, res);
        }

        function check_auth_header(header) {
            if (! header.startsWith('Basic ')) return false;

            header = Buffer.from(header.slice(6), 'base64').toString('utf-8');
            header = header.match(/^([^:]*):(.*)$/);
            if (!header) return false;

            return header[1]||'' === credentials.name  &&  header[2]||'' === credentials.password;
        }

        function basic_auth(req, res) {
            const auth_header = req.headers['authorization'] || '';
            if (check_auth_header(auth_header)) {
                return dispatch(req, res);
            }

            res.setHeader('WWW-Authenticate', `Basic realm="${credentials.realm}"`);
            return r(401, req, res);
        }

        if (!!credentials && credentials.enabled) {
            return basic_auth;
        }
        return dispatch;
    })(settings.auth, methods);


    function setup_websockets(server) {
        const webSocketServer = require('websocket').server;
        const ws_server = new webSocketServer({
            httpServer: server,
            autoAcceptConnections: false
        });
        ws_server.on('request', function(request) {
            if (!!ws_dispatcher.check_origin  &&  !ws_dispatcher.check_origin(request.origin)) {
                return request.reject(401);
            }

            if (!!ws_dispatcher[request.resource]) {
                return ws_dispatcher[request.resource](request.accept(null, request.origin), request);
            }

            return request.reject(404);
        });
    }


    this.start = (function(sserver, shttps) {
        return function() {
            const redirector = (function(fqdn, port, keep_http) {
                return function(req, res) {
                    if (req.method !== 'GET') {
                        return r(405, req, res);
                    }

                    if (!!keep_http  &&  req.url.startsWith(keep_http)) {
                        console.log(`Http GET ${req.url}`);
                        return get_functions.static_content(req, res);
                    }

                    let new_host = fqdn;
                    if (!new_host) {
                        const old_host = req.headers.host||'';
                        if (old_host === '')
                            return r(400, req, res);
                        const port = old_host.match(/:[0-9]+$/);
                        new_host = !!port  ?  old_host.slice(0, port.index)  :  old_host;
                    }

                    const redirect_to = `https://${new_host}:${port}${req.url}`;
                    console.log(`Http GET redirect ${req.url} -> ${redirect_to}`);

                    res.setHeader('Location', redirect_to);
                    return r(301, req, res);
                }
            }(shttps.fqdn, sserver.port, shttps.keep_http));

            function https() {
                function dispatch_on_SYN(socket) {
                    function ondata(buffer) {
                        const isSYN = buffer[0] === 22;

                        socket.pause();
                        socket.unshift(buffer);

                        const server = isSYN ? https : http;
                        server.emit('connection', socket);

                        process.nextTick(function(){ socket.resume(); });
                    }
                    socket.once('data', ondata);
                }

                const https_options = {
                    key: fs.readFileSync(shttps.key),
                    cert: fs.readFileSync(shttps.cert)
                }

                const http = require('http').createServer(redirector);
                const https = require('https').createServer(https_options, the_website);
                const dispatch_server = require('net').createServer(dispatch_on_SYN)
                    .listen(sserver.port|0, sserver.ip);

                console.log(`Started httpx server on ${sserver.ip}:${sserver.port}.`);
                return https;
            }

            function http() {
                const srv = require('http').createServer(the_website)
                    .listen(sserver.port|0, sserver.ip);

                console.log(`Started http server on ${sserver.ip}:${sserver.port}.`);
                return srv;
            }

            let server;
            if (!!shttps  &&  shttps.enabled) {
                server = https();
            } else {
                server = http();
            }
            if (sserver.websocket)
                setup_websockets(server);
        }
    }(settings.server, settings.https));
}(settings, http_dispatcher, ws_dispatcher));

server.start();

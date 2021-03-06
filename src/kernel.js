const uuid = require("uuid");

const { zmq, JupyterSocketTypes, JupyterSocket } = require("./kernel/socket");
const { Session } = require("./session/session");
const { JupyterSendCommMessage } = require('./kernel/messages/flavours/comm_msg');
const { CommMsgRequestHandler,
        CommInfoRequestHandler,
        DefaultRequestHandler,
        ExecuteRequestHandler,
        KernelInfoRequestHandler,
        KernelInterruptRequestHandler,
        ShutdownRequestHandler } = require('./kernel/messages/handlers');
const { SessionMessageCommEvent } = require('./session/postables/events/comm_msg');

/**
 * Implements a Javascript kernel for IPython/Jupyter.
 */
class Kernel {
    constructor({ logger, connection, protocolVersion, buildNumber, startupScript }) {
        this._logger = logger;
        this._connection = connection;
        this._protocolVersion = protocolVersion;

        this._identity = uuid.v4();                         // the kernel's ZMQ identity

        // Socket inits
        // Heart Beating above else
        this._hbSocket = zmq.createSocket("rep", { identity: this._identity });
        this._hbSocket.on("message", this._hbSocket.send);
        this._hbSocket.bindSync(`tcp://${this._connection.ip}:${this._connection.hb_port}`);

        // Setup data socket streams
        const jsOptions = {
            identity: this._identity,
            connectionInfo: this._connection
        };
        this._sockets = {
            [JupyterSocketTypes.IOPub]: new JupyterSocket(JupyterSocketTypes.IOPub, jsOptions),
            [JupyterSocketTypes.STDIn]: new JupyterSocket(JupyterSocketTypes.STDIn, jsOptions),
            [JupyterSocketTypes.SHELL]: new JupyterSocket(JupyterSocketTypes.SHELL, jsOptions),
            [JupyterSocketTypes.CONTROL]: new JupyterSocket(JupyterSocketTypes.CONTROL, jsOptions)
        };
        this._sockets[JupyterSocketTypes.IOPub].on("message", this._onKernelMessage.bind(this));
        this._sockets[JupyterSocketTypes.STDIn].on("message", this._onStdinMessage.bind(this));
        this._sockets[JupyterSocketTypes.SHELL].on("message", this._onKernelMessage.bind(this));
        this._sockets[JupyterSocketTypes.CONTROL].on("message", this._onKernelMessage.bind(this));

        // Initialize more complex objects
        this._session = new Session({ logger, protocolVersion, buildNumber, startupScript });
        this._handlers = {
            _default: new DefaultRequestHandler(this),
            comm_info_request: new CommInfoRequestHandler(this),
            comm_msg: new CommMsgRequestHandler(this),
            execute_request: new ExecuteRequestHandler(this),
            interrupt_request: new KernelInterruptRequestHandler(this),
            kernel_info_request: new KernelInfoRequestHandler(this),
            shutdown_request: new ShutdownRequestHandler(this)
        };

        // Tie event handlers to out-of-session events
        this._session.on(SessionMessageCommEvent.type, ({ comm_id, data }) => {
            let { pMessageInfo, innerData } = data;

            JupyterSendCommMessage.newFor({ 
                    pMessageInfo, comm_id, 
                    data: innerData 
                }).sendVia(this);
        });
    }

    get logger() {
        return this._logger;
    }
    get identity() {
        return this._identity;
    }
    get session() {
        return this._session;
    }
    get connectionInfo() {
        return this._connection;
    }
    get protocolVersion() {
        return this._protocolVersion;
    }
    get sockets() {
        return this._sockets;
    }

    bindAndGo() {
        Object.values(this._sockets).forEach(socket => socket.bindSync());
        this._logger.info('Kernel successfully started and awaiting messages.');
    }

    async restart() {
        return await this._session.restart();
    }

    async shutdown() {
        let killCode;

        // TODO(NR) Handle socket `this.stdin` once it is implemented
        Object.values(this._sockets).forEach(socket => socket.removeAllListeners());
        this._hbSocket.removeAllListeners();
        killCode = await this._session.stop();
        Object.values(this._sockets).forEach(socket => socket.close());
        this._hbSocket.close();

        return killCode;
    }

    async _onKernelMessage(msg) {
        let messageType = msg.info.header.msg_type;
        let requestHandler = this._getRequestHandlerByType(messageType);

        this._logger.silly(`Received a '${messageType}' message.`);
        try {
            requestHandler.handle(msg);
            this._logger.silly(`Handled '${messageType}'`);
        } catch (e) {
            this._logger.error(`Exception in ${messageType} handler: ${e}`);
        }
    }

    _onStdinMessage(msg) {
        // TODO: handle these types of messages at some point
    }

    _getRequestHandlerByType(rawMessageType) {
        let targetedHandler = this._handlers[rawMessageType];

        if (!targetedHandler) {
            targetedHandler = this._handlers._default;
        }
        return targetedHandler;
    }
}

module.exports = { Kernel };
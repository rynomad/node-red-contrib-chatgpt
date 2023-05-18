/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

/**
 * @typedef LinkTarget
 * @type {object}
 * @property {string} id - ID of the target node.
 * @property {string} name - Name of target Node
 * @property {number} flowId - ID of flow where the target node exists
 * @property {string} flowName - Name of flow where the target node exists
 * @property {boolean} isSubFlow - True if the link-in node exists in a subflow instance
 */

module.exports = function (RED) {
    "use strict";
    const crypto = require("crypto");

    function PromptGPTNode(n) {
        RED.nodes.createNode(this, n);
        this.server = n.server;
        this.realSend = this.send;
        let id = null;
        let inFlight = false;
        this.send = (msg) => {
            if (
                msg._session?.type === "websocket" &&
                msg._session?.id === id &&
                !inFlight
            ) {
                inFlight = true;
                console.log("overwritten send", id, msg);
                msg.server = this.server;

                // is input from websocket listener
                handleInput(
                    msg,
                    (_msg) => {
                        inFlight = false;
                        console.log("got link reply, send ", _msg);
                        if (_msg.propagateResponse) {
                            console.log("realSend");
                            this.realSend(_msg);
                        } else {
                        }
                    },
                    () => {
                        //done, no-op
                    }
                );
            } else if (
                msg._session?.type === "websocket" &&
                msg._session?.id === id
            ) {
                inFlight = false;
                if (msg.propagateResponse) {
                    console.log("realSend");
                    this.realSend(msg);
                }
                // this.serverConfig.reply(msg._session.id, JSON.stringify(msg))
            } else {
                this.realSend(msg);
            }
        };
        var node = this;
        var currentConfig = this.config;
        this.serverConfig = RED.nodes.getNode(this.server);
        if (this.serverConfig) {
            this.serverConfig.registerInputNode(this);
            // TODO: nls
            this.serverConfig.on("opened", function (event) {
                console.log(event);
                id = event.id;
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: RED._("websocket.status.connected", {
                        count: event.count,
                    }),
                    event: "connect",
                    _session: { type: "websocket", id: event.id },
                });
            });
            this.serverConfig.on("error", function (event) {
                id = null;
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "common.status.error",
                    event: "error",
                    _session: { type: "websocket", id: event.id },
                });
            });
            this.serverConfig.on("closed", function (event) {
                id = null;
                var status;
                if (event.count > 0) {
                    status = {
                        fill: "green",
                        shape: "dot",
                        text: RED._("websocket.status.connected", {
                            count: event.count,
                        }),
                    };
                } else {
                    status = {
                        fill: "red",
                        shape: "ring",
                        text: "common.status.disconnected",
                    };
                }
                status.event = "disconnect";
                status._session = { type: "websocket", id: event.id };
                node.status(status);
            });
        } else {
            this.error(RED._("websocket.errors.missing-conf"));
        }
        this.on("close", function () {
            if (node.serverConfig) {
                node.serverConfig.removeInputNode(node);
            }
            node.status({});
        });
        const staticTarget = "f2342d49916a4e23"; //;

        const messageEvents = {};
        function handleInput(msg, send, done) {
            try {
                if (n.mode === "system" && msg.system) {
                    msg.history = [
                        {
                            role: "system",
                            content: msg.system,
                        },
                    ];
                } else if (n.mode === "system" && n.system) {
                    msg.history = [
                        {
                            role: "system",
                            content: n.system,
                        },
                    ];
                } else if (n.mode === "prompt" && n.prompt) {
                    msg.payload = n.prompt;
                }

                if (parseInt(n.quantity) > 1) {
                    msg.n = n.quantity;
                }

                const currentMessage = [{ role: "user", content: msg.payload }];
                const history = msg.history || [];
                const historyToStash = history.concat(currentMessage);
                const historyToSend =
                    n.mode === "prompt" ? currentMessage : historyToStash;

                if (msg.server) {
                    const serverConfig = RED.nodes.getNode(msg.server);

                    serverConfig.reply(
                        msg._session.id,
                        JSON.stringify(historyToSend)
                    );

                    serverConfig.reply(
                        msg._session.id,
                        JSON.stringify([{ role: "wait" }])
                    );
                }

                const targetNode = RED.nodes.getNode(staticTarget);
                msg._linkSource = msg._linkSource || [];
                const messageEvent = {
                    id: crypto.randomBytes(14).toString("hex"),
                    node: node.id,
                };
                messageEvents[messageEvent.id] = {
                    msg: RED.util.cloneMessage(msg),
                    send,
                    done,
                    history: historyToStash,
                };
                msg._linkSource.push(messageEvent);
                console.log("targetNode?", targetNode, msg);
                targetNode.receive(msg);
            } catch (error) {
                node.error(error, msg);
            }
        }

        this.on("input", handleInput);

        this.returnLinkMessage = function (eventId, msg) {
            if (
                Array.isArray(msg._linkSource) &&
                msg._linkSource.length === 0
            ) {
                delete msg._linkSource;
            }

            if (msg.system) {
                delete msg.system;
            }

            if (msg.n) {
                delete msg.n;
            }

            if (msg.full.data.choices.length > 1) {
                msg.payload = msg.full.data.choices
                    .map(
                        ({ message }, i) =>
                            `---OPTION ${i} START---\n${message.content}\n---OPTION ${i} END---\n`
                    )
                    .join("");
                msg.history[msg.history.length - 1].content = msg.payload;
            }

            const messageEvent = messageEvents[eventId];
            if (messageEvent) {
                delete messageEvents[eventId];
                messageEvent.send(msg);
                messageEvent.done();
            } else {
                node.send(msg);
            }

            if (msg.server) {
                const serverConfig = RED.nodes.getNode(msg.server);
                serverConfig.reply(
                    msg._session.id,
                    JSON.stringify(
                        msg.history.slice(messageEvent?.history?.length)
                    )
                );
                if (
                    Object.keys(node.wires).length === 0 ||
                    this.wires[0].length === 0 ||
                    !msg.propagateResponse
                ) {
                    // No downstream nodes
                    serverConfig.reply(
                        msg._session.id,
                        JSON.stringify([{ role: "end" }])
                    );
                }
            }
        };
    }
    RED.nodes.registerType("PromptGPT", PromptGPTNode);
};

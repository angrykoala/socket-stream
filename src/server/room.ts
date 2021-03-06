import { EventEmitter } from 'events';
import SocketIO, { Socket } from 'socket.io';
import { Peer } from './peer';
import { RoomDispatcher } from './room_dispatcher';
import { ConnectionRequestResponse, SocketEvents } from '../common/types';
import { arrayfy } from '../common/utils';

type SignalEvent = {
    target: string
    signal: any
};

export type SocketWebRTCRoomOptions = {
    iceServers?: Array<RTCIceServer>
};

export class SocketWebRTCRoom extends EventEmitter {
    private peers: Map<string, Peer> = new Map();
    private rolesConnections: Map<string, Set<string>> = new Map();
    private io: SocketIO.Namespace;
    private options: SocketWebRTCRoomOptions;
    public readonly name: string;

    constructor(io: SocketIO.Server, name: string = 'default', options: SocketWebRTCRoomOptions = {}) {
        super();
        RoomDispatcher.registerRoom(name);
        this.io = io.of(`socketstream_${name}`);
        this.name = name;
        this.options = options;
        this.setupSockets();
        this.connectRoles("default", "default");
    }

    public connectRoles(role1: string, role2: string): void {
        const role1Set = this.getOrSetRoleSet(role1);
        const role2Set = this.getOrSetRoleSet(role2);

        role1Set.add(role2);
        role2Set.add(role1);
    }

    public disconnectRoles(role1: string, role2: string): void {
        const role1Set = this.getOrSetRoleSet(role1);
        const role2Set = this.getOrSetRoleSet(role2);

        role1Set.delete(role2);
        role2Set.delete(role1);
    }

    public registerPeer(peer: Peer): void {
        console.log("Register Peer", peer.id);
        this.notifyPeersOf(peer, SocketEvents.AddPeer, peer.serialize());
        this.peers.set(peer.id, peer);
    }

    public sendTo(target: Peer | string | Array<Peer> | Array<string>, event: string, data?: any): void {
        const targets = arrayfy(target);

        targets.forEach((peerOrRole: Peer | string) => {
            this.sendToPeerOrRole(peerOrRole, event, data);
        });
    }

    public notifyPeersOf(sourcePeer: Peer, event: string, data?: any): void {
        const connectedPeers = this.getPeersConnectedTo(sourcePeer);
        for (const peer of connectedPeers) {
            peer.emit(event, data);
        }
    }

    public isPeerRegistered(peer: Peer): boolean {
        return this.peers.has(peer.id);
    }

    private setupSockets(): void {
        this.io.on('connection', (socket: Socket) => {
            const peer = new Peer(socket);

            socket.on(SocketEvents.ConnectRequest, (payload: any, response: (response: ConnectionRequestResponse) => void) => {
                this.emit('connection', peer, payload);
                response({
                    iceServers: this.options.iceServers
                });
            });

            socket.on('disconnect', () => {
                if (!this.isPeerRegistered(peer)) return;
                console.log("Disconnect", socket.id);
                this.emit('disconnect', peer);
                this.peers.delete(peer.id);
                this.notifyPeersOf(peer, SocketEvents.PeerDisconnected, peer.serialize());

            });

            socket.on(SocketEvents.Signal, ({ target, signal }: SignalEvent) => {
                if (!this.isPeerRegistered(peer)) return;
                const targetPeer = this.peers.get(target);
                if (!targetPeer || !this.arePeersConnected(peer, targetPeer)) return;
                console.log(`Signal from ${socket.id} to ${target}`);
                targetPeer.emit(SocketEvents.Signal, {
                    source: socket.id,
                    signal
                });
            });
        });
    }

    private getOrSetRoleSet(role: string): Set<string> {
        let roleSet = this.rolesConnections.get(role);
        if (!roleSet) {
            roleSet = new Set<string>();
            this.rolesConnections.set(role, roleSet);
        }
        return roleSet;
    }

    private getPeersOfRole(role: string): Array<Peer> {
        return Array.from(this.peers.values()).filter((candidatePeer: Peer) => {
            return candidatePeer.hasRole(role);
        });
    }

    // TODO: improve performance
    private getPeersConnectedTo(peer: Peer): Array<Peer> {
        return Array.from(this.peers.values()).filter((candidatePeer: Peer) => {
            return this.arePeersConnected(peer, candidatePeer);
        });
    }

    private arePeersConnected(peer1: Peer, peer2: Peer): boolean {
        if (peer1.id === peer2.id) return false; // A peer cannot be connected to itself
        for (const role1 of peer1.roles) {
            for (const role2 of peer2.roles) {
                if (this.areRolesConnected(role1, role2)) {
                    return true;
                }
            }
        }
        return false;
    }

    private areRolesConnected(role1: string, role2: string): boolean {
        if (!role1 || !role2) return false;
        const role1Connections = this.rolesConnections.get(role1);
        if (!role1Connections) return false;
        return role1Connections.has(role2);
    }

    private sendToPeerOrRole(target: Peer | string, event: string, data?: any): void {
        if (target instanceof Peer) {
            target.emit(event, data);
        } else {
            this.getPeersOfRole(target).forEach((peer: Peer) => {
                peer.emit(event, data);
            });
        }
    }
}

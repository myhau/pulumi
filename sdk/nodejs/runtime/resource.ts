// Copyright 2016-2017, Pulumi Corporation.  All rights reserved.

import * as asset from "../asset";
import { Property, PropertyValue } from "../property";
import { Resource, URN } from "../resource";
import { Log } from "./log";
import { getMonitor, isDryRun } from "./settings";

let langproto = require("../proto/nodejs/languages_pb");
let gstruct = require("google-protobuf/google/protobuf/struct_pb.js");

// registerResource registers a new resource object with a given type t and name.  It returns the auto-generated URN
// and the ID that will resolve after the deployment has completed.  All properties will be initialized to property
// objects that the registration operation will resolve at the right time (or remain unresolved for deployments).
export function registerResource(
    res: Resource, t: string, name: string, props: {[key: string]: PropertyValue<any> | undefined}): void {
    Log.debug(`Registering resource: t=${t}, name=${name}, props=${props}`);

    // Fetch the monitor; if it doesn't exist, bail right away.
    let monitor: any = getMonitor();
    if (!monitor) {
        return;
    }

    // Create a resource URN and an ID that will get populated after deployment.
    let urn = new Property<URN>();
    let id = new Property<string>();

    // Store these properties, plus all of those passed in, on the resource object.  Note that we do these using
    // any casts because they are typically readonly and this function is in cahoots with the initialization process.
    let transfer: Promise<any> = transferProperties(res, props);
    (<any>res).urn = urn;
    (<any>res).id = id;

    // During a real deployment, the transfer operation may take some time to settle (we may need to wait on
    // other in-flight operations.  As a result, we can't launch the RPC request until they are done.  At the same
    // time, we want to give the illusion of non-blocking code, so we return immediately.
    transfer.then((obj: any) => {
        Log.debug(`Resource RPC prepared: t=${t}, name=${name}, obj=${obj}`);

        // Fire off an RPC to the monitor to register the resource.  If/when it resolves, we will blit the properties.
        let req = new langproto.NewResourceRequest();
        req.setType(t);
        req.setName(name);
        req.setObject(obj);
        monitor.newResource(req, (err: Error, resp: any) => {
            Log.debug(`Resource RPC finished: t=${t}, name=${name}; err: ${err}, resp: ${resp}`);
            if (err) {
                throw new Error(`Failed to register new resource with monitor: ${err}`);
            }
            else {
                // The resolution will always have a valid URN, even during planning.
                urn.resolve(resp.getUrn());

                // The ID and properties, on the other hand, are only resolved to values during deployments.
                let newID: any = resp.getId();
                if (newID) {
                    id.resolve(newID);
                }
                let newProperties: any = resp.getObject();
                if (newProperties) {
                    resolveProperties(newProperties, res);
                }
            }
        });
    });
}

// transferProperties stores the properties on the resource object and returns a gRPC serializable
// proto.google.protobuf.Struct out of a resource's properties.
function transferProperties(
    res: Resource, props: {[key: string]: PropertyValue<any> | undefined}): Promise<any> {
    let obj: any = {}; // this will eventually hold the serialized object properties.
    let eventuals: Promise<void>[] = []; // this contains all promises outstanding for assignments.
    if (props) {
        for (let k of Object.keys(props)) {
            // Create a property to wrap the value and store it on the resource.
            let p = new Property<any>(props[k]);
            if ((<any>res)[k]) {
                throw new Error(`Property '${k}' is already initialized on this resource object`);
            }
            (<any>res)[k] = p;

            // Now serialize the value and store it in our map.  This operation may return eventuals that resolve
            // after all properties have settled, and we may need to wait for them before this transfer finishes.
            if (p.has()) {
                eventuals.push(serializeProperty(p.require()).then((v) => {
                    obj[k] = v;
                }));
            } else {
                let link: PropertyValue<any> | Promise<any> | undefined = p.linked();
                if (link) {
                    eventuals.push(serializeProperty(link).then((v) => {
                        obj[k] = v;
                    }));
                }
            }
        }
    }
    // Now return a promise that resolves when all assignments above have settled.  Note that we do not
    // use await here, because we don't actually want to block the above assignments of properties.
    return Promise.all(eventuals).then(() => {
        return gstruct.Struct.fromJavaScript(obj);
    });
}

// resolveProperties takes as input a gRPC serialized proto.google.protobuf.Struct and resolves all of the
// resource's matching properties to the values inside.
function resolveProperties(struct: any, res: Resource): void {
    // First set any properties present in the output object.
    let props: any = struct.toJavaScript();
    for (let k of Object.keys(props)) {
        let p: any = (<any>res)[k];
        if (!(p instanceof Property)) {
            throw new Error(`Unable to set resource property '${k}' because it is not a Property<T>`);
        }
        p.resolve(deserializeProperty(props[k]));
    }
    // Now latch any other properties to their final values, in case they aren't set.
    for (let k of Object.keys(res)) {
        let p: any = (<any>res)[k];
        if (p instanceof Property) {
            p.done();
        }
    }
}

// unknownPropertyValue is a special value that the monitor recognizes.
export const unknownPropertyValue = "04da6b54-80e4-46f7-96ec-b56ff0331ba9";
// specialSigKey is sometimes used to encode type identity inside of a map.  See pkg/resource/properties.go.
export const specialSigKey = "4dabf18193072939515e22adb298388d";
// specialAssetSig is a randomly assigned hash used to identify assets in maps.  See pkg/resource/asset.go.
export const specialAssetSig = "c44067f5952c0a294b673a41bacd8c17";
// specialArchiveSig is a randomly assigned hash used to identify archives in maps.  See pkg/resource/asset.go.
export const specialArchiveSig = "0def7320c3a5731c473e5ecbe6d01bc7";

// serializeProperty serializes properties deeply.  This understands how to wait on any unresolved promises, as
// appropriate, in addition to translating certain "special" values so that they are ready to go on the wire.
async function serializeProperty(prop: any): Promise<any> {
    if (prop === undefined || typeof prop === "boolean" ||
            typeof prop === "number" || typeof prop === "string") {
        return prop;
    }
    else if (prop instanceof Array) {
        let elems: any[] = [];
        for (let e of prop) {
            elems.push(await serializeProperty(e));
        }
        return elems;
    }
    else if (prop instanceof Resource) {
        // Resources aren't serializable; instead, we serialize them as references to the ID property.
        return await serializeProperty(prop.id);
    }
    else if (prop instanceof asset.Asset || prop instanceof asset.Archive) {
        // Serializing an asset or archive requires the use of a magical signature key, since otherwise it would look
        // like any old weakly typed object/map when received by the other side of the RPC boundary.
        let obj: any = {
            [specialSigKey]: (prop instanceof asset.Asset ? specialAssetSig : specialArchiveSig),
        };
        for (let k of Object.keys(prop)) {
            obj[k] = await serializeProperty((<any>prop)[k]);
        }
        return obj;
    }
    else if (prop instanceof Promise) {
        // If this is a promise from an ordinary I/O operation, await it.
        let v: any = await prop;
        return await serializeProperty(v);
    }
    else if (prop instanceof Property) {
        // If this is a property linked to the completion of another one, it's computed.  In the case
        // of a dry run, we cannot know its value, so we say so.  For other cases, we must wait.
        if (isDryRun()) {
            return unknownPropertyValue;
        }
        return await new Promise<any>((resolve) => {
            prop.then((v) => {
                resolve(serializeProperty(v));
            });
        });
    }
    else {
        let obj: any = {};
        for (let k of Object.keys(prop)) {
            obj[k] = await serializeProperty(prop[k]);
        }
        return obj;
    }
}

// deserializeProperty unpacks some special types, reversing the above process.
function deserializeProperty(prop: any): any {
    if (prop === undefined || typeof prop === "boolean" ||
            typeof prop === "number" || typeof prop === "string") {
        return prop;
    }
    else if (prop instanceof Array) {
        let elems: any[] = [];
        for (let e of prop) {
            elems.push(deserializeProperty(e));
        }
        return elems;
    }
    else {
        // We need to recognize assets and archives specially, so we can produce the right runtime objects.
        let sig: any = prop[specialSigKey];
        if (sig) {
            switch (sig) {
                case specialAssetSig:
                    if (prop["path"]) {
                        return new asset.File(<string>prop["path"]);
                    } else if (prop["text"]) {
                        return new asset.String(<string>prop["text"]);
                    } else if (prop["uri"]) {
                        return new asset.Remote(<string>prop["uri"]);
                    } else {
                        throw new Error("Invalid asset encountered when unmarshaling resource property");
                    }
                case specialArchiveSig:
                    if (prop["assets"]) {
                        let assets: {[name: string]: asset.Asset} = {};
                        for (let name of Object.keys(prop["assets"])) {
                            let a = deserializeProperty(prop["assets"][name]);
                            if (!(a instanceof asset.Asset)) {
                                throw new Error("Expected an AssetArchive's assets to be unmarshaled Asset objects");
                            }
                            assets[name] = a;
                        }
                        return new asset.AssetArchive(assets);
                    } else if (prop["path"]) {
                        return new asset.FileArchive(<string>prop["path"]);
                    } else if (prop["uri"]) {
                        return new asset.RemoteArchive(<string>prop["uri"]);
                    } else {
                        throw new Error("Invalid archive encountered when unmarshaling resource property");
                    }
                default:
                    throw new Error(`Unrecognized signature '${sig}' when unmarshaling resource property`);
            }
        }

        // If there isn't a signature, it's not a special type, and we can simply return the object as a map.
        let obj: any = {};
        for (let k of Object.keys(prop)) {
            obj[k] = deserializeProperty(prop[k]);
        }
        return obj;
    }
}


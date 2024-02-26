import * as FS from "browser-fs-access"

export class VfsNode {
    constructor(name, metadata) {
        this.name = name;
        this.metadata = metadata;
        this.parent = null;
        this._children = {}
    }

    get path() {
        let cnode = this;
        let names = [cnode.name];
        while (cnode.parent != null) {
            cnode = cnode.parent;
            names.push(cnode.name);
        }
        return names.reverse().join("/");
    }

    *children() {
        for (const cname of Object.getOwnPropertyNames(this._children)) {
            yield this._children[cname];
        }
    }
}

function normalize_path(path) {
    if (typeof(path) == 'string') {
        return path.split("/").filter(s=>s.length>0)
    } 
    return path;
}

export class Vfs {
    constructor() {
        this.node_id = 0;
        this.root = new VfsNode("", {id: this.node_id++});
        this.mount_points = [];
    }

    _push(mount, segments, metadata) {
        let cnode = mount;
        for (const segment of normalize_path(segments)) {
            if (!(segment in cnode._children)) {
                cnode._children[segment] = new VfsNode(segment, {id: this.node_id++, type: "folder"});
                cnode._children[segment].parent = cnode;
            }
            cnode = cnode._children[segment];
        }
        cnode.metadata = Object.assign(cnode.metadata, {type:"file"}, metadata);
        return cnode;
    }

    _open(mount, segments) {
        let cnode = mount;
        for (const segment of normalize_path(segments)) {
            if (!(segment in cnode._children)) {
                return null;
            }
            cnode = cnode._children[segment];
        }
        return cnode;
    }

    open(segments) {
        return this._open(this.root, segments);
    }

    ls(segments) {
        let cnode = this.open(segments);
        if (cnode == null) {
            return null;
        }
        return Array.from(cnode.children()).map(node=>node.name);
    }

    get_mount(path) {
        for (const mount_point of this.mount_points) {
            if (path.startsWith(mount_point.path)) {
                return [mount_point, path.slice(mount_point.path.length)]
            }
        }        
        return [null, path];
    }

    mkdir(path) {
        const [mount_point, rest] = this.get_mount(path);
        if (mount_point == null) {
            return this._mkdir_memfs(this.root, rest);            
        } else if (mount_point.type == "local") {
            return this._mkdir_local(mount_point, rest);            
        }
    }

    async write_file(path, file_name, content, metadata) {
        const blob = new Blob([content], { type: metadata || "plain/text" });
        blob.name = file_name;

        const [mount_point, rest] = this.get_mount(path);
        if (mount_point == null) {
            return this._write_file_memfs(this.root, rest, blob);            
        } else if (mount_point.type == "local") {
            return this._write_file_local(mount_point, rest, blob);            
        }
    }

    // ------------------------------------------- MemFS Mounts ------------------------------------------ 
    _mkdir_memfs(root, path) {
        return this._push(root, path, {type: "folder"});
    }

    _write_file_memfs(root, path, blob) {
        return this._push(root, path, {type: "file", blob});
    }

    // ------------------------------------------- Local Mounts ------------------------------------------ 
    async mount_local_file(path) {
        try {
            const _root = this.open(path);
            const blob = await FS.fileOpen();
            const mount_node = this._push(_root, blob.name, {blob, type: "file" });
            this.mount_points.push({
                type: "local",
                path: path+"/"+blob.name,
                root: mount_node
            });
            return mount_node;
        } catch (e) {
            return false;
        }
    }

    async mount_local_folder(path) {
        try {
            const _root = this.open(path);
            const blobs = await FS.directoryOpen({recursive: true});
            let last_path = null;
            for (const blob of blobs) {
                last_path = blob.webkitRelativePath; 
                const node = this._push(_root, blob.webkitRelativePath, { blob });
                node.parent.metadata = Object.assign(node.parent.metadata, {directoryHandle: blob.directoryHandle})
            }
            if (last_path == null) {
                return false;
            }
            const root_name = normalize_path(last_path)[0];
            const mount_node = _root._children[root_name];
            this.mount_points.push({
                type: "local",
                path: path+"/"+root_name,
                root: mount_node
            });
            return mount_node;
        } catch (e) {
            return false;
        } 
    }

    _closest_directory_handler_local(mount, path) {
        let segments = normalize_path(path);
        let to_create = [];
        while (true) {
            const pdir = this._open(mount, segments);
            if (pdir && pdir.metadata.directoryHandle) {
                return [pdir.metadata.directoryHandle, pdir, to_create.reverse()]
            }
            if (segments.length == 0) {
                break;
            }
            to_create.push(segments.pop());
        }
        return [null, null, null]
    }

    async _mkdir_local(mount, path) {
        let [handler, node, rest] = this._closest_directory_handler_local(mount.root, path);
        if (handler == null) {
            return null;
        }
        this._push(node, rest, {type: "folder"});

        for (const pdir of rest) {
            let new_handler = await handler.getDirectoryHandle(pdir, {create: true});
            node = node._children[pdir];
            node.metadata.directoryHandle = new_handler;
            handler = new_handler;
        }
        return node
    }

    async _write_file_local(mount, path, blob) {
        let [handler, node, rest] = this._closest_directory_handler_local(mount.root, path);
        if (handler == null) {
            return null;
        }
        this._push(node, rest, {type: "file"});
    }
}

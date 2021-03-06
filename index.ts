import Mirai from 'node-mirai-sdk';

import QRCode from 'qrcode'
// const { Plain, At } = Mirai.MessageComponent;
import { Low, JSONFile } from "lowdb";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import log from 'fancy-log';
import fetch from 'node-fetch';
import { GroupSender, Permission } from 'node-mirai-sdk/types/src/typedef';
import { appendFileSync } from 'fs';
const { Plain, At, Image } = Mirai.MessageComponent;
const __dirname = dirname(fileURLToPath(import.meta.url));

interface ParsedCookie {
    jct: string,
    SESSDATA: string,
    all: string
}

function parseCookie(setcookie: string): ParsedCookie | undefined {
    
    let jct = /bili_jct=(\S+);/.exec(setcookie)
    let sessdata = /SESSDATA=(\S+);/.exec(setcookie)
    if (jct && sessdata) return {
        jct: jct[1],
        SESSDATA: sessdata[1],
        all: `bili_jct=${jct[1]};SESSDATA=${sessdata[1]};`
    }
    return undefined
}

type LoginData = {
    cookie: string | null,
    oauthKey: string | null,
    allowUses: number[]
}
let initUserData: LoginData = { cookie: null, oauthKey: null, allowUses: [] };

type Config = {
    login_data: { [qqnum: number]: LoginData },
    using_livingroom: { [qqnum: number]: number }
}

interface ParsedMessage {
    sender: number,
    group: number,
    command: string | null,
    arguments: Array<string>,
    at: number | null,
    forwarded_msg: number | null,
    forwarded_sender: number | null,
    source: number
}

function to_form(details: any) {
    var formBody = [];
    for (var property in details) {
        var encodedKey = encodeURIComponent(property);
        var encodedValue = encodeURIComponent(details[property]);
        formBody.push(encodedKey + "=" + encodedValue);
    }
    return formBody.join("&");
}

const file = join(__dirname, "borrow_livingroom_db.json");
const adapter = new JSONFile<Config>(file);
const db = new Low<Config>(adapter);

function getSecond(arg2: string) {
    let arg = arg2.split("+");
    let total = 0;
    for (let i = 0; i < arg.length; i++) {
        if (!arg[i]) { continue; }
        total += get(arg[i]);
    }
    return total;

    function get(arg2: string) {
        let ts = 0, isAdd = !/^-/.test(arg2);
        let dt: any = {};

        arg2 = arg2.replace(/[\+\- ]/g, '');
        // ?????????????????????
        dt.num = arg2.replace(/[^\d]/g, '');
        dt.typ = arg2.replace(dt.num, '');

        dt.num = parseInt(dt.num);
        isAdd && (dt.num *= -1);

        switch (dt.typ) {
            case 'd': case 'day': case 'days':
                ts -= dt.num * (24 * 60 * 60 * 1000);
                break;
            case 'h': case 'hour': case 'hours':
                ts -= dt.num * (60 * 60 * 1000);
                break;
            case 'i': case 'min': case 'minute': case 'minutes':
                ts -= dt.num * (60 * 1000);
                break;
            case 's': case 'sec': case 'second': case 'seconds':
                ts -= dt.num * 1000;
                break;
            case 'ms': case 'millisecond': case 'milliseconds':
                ts -= dt.num;
                break;
        }
        return ts / 1000;
    }
}

function is<T extends object>(v: any, k: string): v is T {
    return k in v;
}

async function main() {
    log("Reading database...");
    await db.read();
    db.data = db.data||{
        login_data: {},
        using_livingroom: {}
    }


    log("Attempting to connect to Mirai...");
    const bot = new Mirai({
        host: 'http://localhost:8080',
        verifyKey: '??????vkey',
        qq: 2944969546,
        enableWebsocket: true,
        wsOnly: false,
    });


    function auth() {
        return new Promise<void>((rs) => {
            bot.onSignal('authed', async () => {
                log(`Authed with session key ${bot.sessionKey}`);
                await bot.verify();
                log("Succeeded.")
                rs()
            });
        })
    }
    await auth()


    await db.write();

    const groupList_ = await bot.getGroupList();
    const groupList = groupList_.filter(v => v.permission == "ADMINISTRATOR" || v.permission == "OWNER")

    bot.onMessage(async function (data) {
        if (!is<GroupSender>(data.sender, "group")) return;
        if (!data.messageChain[0].id) return;
        if (!db.data) return;

        let message: ParsedMessage = {
            sender: data.sender.id,
            group: data.sender.group.id,
            command: null,
            arguments: [],
            at: null,
            forwarded_msg: null,
            forwarded_sender: null,
            source: data.messageChain[0].id
        };

        if (message.group != 808655158) return;


        for (let msg of data.messageChain) {
            if (msg.text) {
                if (message.command) {
                    message.arguments?.push(...msg.text.trim().split(" "));
                } else {
                    let firstword: string = msg.text.trim().split(" ")[0], firstchar = firstword.charAt(0);
                    if ([":", ".", "!", "/"].includes(firstchar))
                        message.command = firstword.slice(1);
                    message.arguments?.push(...msg.text.trim().split(" ").slice(1));
                }
            }
            if (msg.target) {
                message.at = msg.target;
            }
            if (msg.senderId && msg.id) {
                message.forwarded_msg = msg.id;
                message.forwarded_sender = msg.senderId
            }
        }


        if (!message.command) return;
        log("New Command -> ", message);



        switch (message.command) {
            case "bl:login": {
                let login_data: any = await (await fetch("https://passport.bilibili.com/qrcode/getLoginUrl")).json()

                if (!db.data.login_data[message.sender]) db.data.login_data[message.sender] = initUserData;
                db.data.login_data[message.sender].oauthKey = login_data.data["oauthKey"]
                await db.write()

                await QRCode.toFile("qrtemp_" + message.sender + ".png", login_data.data["url"])
                let image = await bot.uploadImage("qrtemp_" + message.sender + ".png", data);
                let msgresp = (await bot.sendGroupMessage([Plain("????????????????????? - Bilibili????????????"), Image(image), Plain("??????100s???????????????")], message.group));
                if (!msgresp.messageId) return;
                let handle = setInterval(async () => {
                    if (!msgresp.messageId) return;
                    if (!db.data) return;

                    let resp = await fetch("http://passport.bilibili.com/qrcode/getLoginInfo", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
                        },
                        body: to_form({
                            oauthKey: db.data.login_data[message.sender].oauthKey
                        })
                    })

                    let data: any = await resp.json();


                    if (data.status) {
                        db.data.login_data[message.sender].cookie = resp.headers.get("set-cookie");
                        await db.write();
                        await bot.recall(parseInt(msgresp.messageId));
                        await bot.sendGroupMessage([Plain("????????????????????? - Bilibili?????????????????????")], message.group);
                        clearTimeout(h2)
                    }
                    if (data.code == -1 || data.code == -2) {
                        db.data.login_data[message.sender].oauthKey = null;
                        await db.write();
                    }
                }, 1000)
                let h2 = setTimeout(async () => {
                    clearInterval(handle)
                    if (msgresp.messageId)
                        await bot.recall(parseInt(msgresp.messageId));
                    await bot.sendGroupMessage([Plain("????????????????????? - Bilibili??????????????????????????????")], message.group);
                }, 100 * 1000);
                break;
            }
            case "bl:allowUse": {
                let target = message.at;
                if (!target) return;
                if (!db.data.login_data[message.sender]){ await bot.sendGroupMessage([Plain("??????????????????????????????????????????!bl:login?????????")], message.group);return;
                }
                db.data.login_data[message.sender].allowUses.push(target)
                await db.write();
                await bot.sendGroupMessage([Plain("???????????????:P\n????????????????????????????????????" + db.data.login_data[message.sender].allowUses.join(","))], message.group);
                break;
            }
            case "bl:removeUse": {
                let target = message.at;
                if (!target) return;
                if (!db.data.login_data[message.sender]) {await bot.sendGroupMessage([Plain("??????????????????????????????????????????!bl:login?????????")], message.group);return;
                }
                db.data.login_data[message.sender].allowUses = db.data.login_data[message.sender].allowUses.filter(v => v != target)
                await db.write();
                await bot.sendGroupMessage([Plain("???????????????:P\n????????????????????????????????????" + db.data.login_data[message.sender].allowUses.join(","))], message.group);
                break;
            }
            case "bl:use": {
                let target = message.at;
                if (!target) return;
                if (!db.data.login_data[target]) {await bot.sendGroupMessage([Plain("????????????????????????????????????")], message.group);return;
                }
                if (!db.data.login_data[target].allowUses.includes(message.sender)) {await bot.sendGroupMessage([Plain("??????????????????????????????????????????????????? !bl:allowUse @??? ?????????????????????")], message.group);return;
                }
                db.data.using_livingroom[message.sender] = target;
                await db.write();
                await bot.sendGroupMessage([Plain("???????????????:P")], message.group);
                break;
            }
            case "bl:setTitle": {
                if (!message.arguments[0])
                    return;
                let roomqq = db.data.using_livingroom[message.sender];
                if (!roomqq) {
                    await bot.sendGroupMessage([Plain("????????????????????????????????????")], message.group);
                    return;
                }
                log("SetTitle",roomqq,message.arguments[0])
                let room = db.data.login_data[roomqq];
                if (!room || !room.cookie)
                    return;
                let parsed = parseCookie(room.cookie);
                if (!parsed)
                    return;
                let roomid = await getRoomID(parsed.all);
                let resp = await (await fetch("https://api.live.bilibili.com/room/v1/Room/update", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                        "Cookie": parsed.all
                    },
                    body: to_form({
                        title: message.arguments[0],
                        csrf: parsed.jct,
                        room_id: roomid
                    })
                })).json();
                await bot.sendGroupMessage([Plain("???????????????\n????????????" + JSON.stringify(resp))], message.group);
                break;
            }
            case "bl:startLive": {
                if (!message.arguments[0])message.arguments[0]="107"
                let roomqq = db.data.using_livingroom[message.sender];
                if (!roomqq) {
                    await bot.sendGroupMessage([Plain("????????????????????????????????????")], message.group);
                    return;
                }
                log("StartLive",roomqq)
                let room = db.data.login_data[roomqq];
                if (!room || !room.cookie)
                    return;
                let parsed = parseCookie(room.cookie);
                if (!parsed)
                    return;
                let roomid = await getRoomID(parsed.all);
                let form=to_form({
                    platform: "pc",
                    csrf: parsed.jct,
                    csrf_token: parsed.jct,
                    room_id: parseInt(roomid),
                    area_v2: parseInt(message.arguments[0])
                })
                console.log(parsed.all)
                let resp:any = await (await fetch("https://api.live.bilibili.com/room/v1/Room/startLive", {
                    method:"POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                        "Cookie": parsed.all
                    },
                    body: form
                })).text();
                log(resp,form);
                await bot.sendTempMessage([Plain(`[BorrowLivingRoomBot] ???????????????\n?????????(?????????)???${message.sender}\nRTMP???????????????${resp.data.rtmp.addr}\nRTMP???????????????${resp.data.rtmp.code}`)],roomqq,message.group);
                await bot.sendTempMessage([Plain(`[BorrowLivingRoomBot] ???????????????\nRTMP???????????????${resp.data.rtmp.addr}\nRTMP???????????????${resp.data.rtmp.code}`)],message.sender,message.group);
                await bot.sendGroupMessage([Plain("???????????????rtmp??????&????????????????????????")], message.group);
                break;
            }
            case "bl:stopLive": {
                if (!message.arguments[0])message.arguments[0]="107"
                let roomqq = db.data.using_livingroom[message.sender];
                if (!roomqq) {
                    await bot.sendGroupMessage([Plain("????????????????????????????????????")], message.group);
                    return;
                }
                log("StopLive",roomqq)
                let room = db.data.login_data[roomqq];
                if (!room || !room.cookie)
                    return;
                let parsed = parseCookie(room.cookie);
                if (!parsed)
                    return;
                let roomid = await getRoomID(parsed.all);
                let resp:any = await (await fetch("https://api.live.bilibili.com/room/v1/Room/stopLive", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                        "Cookie": parsed.all
                    },
                    body: to_form({
                        csrf: parsed.jct,
                        csrf_token: parsed.jct,
                        room_id: roomid,
                    })
                })).json();
                if(resp.code)await bot.sendGroupMessage([Plain("???????????????\n????????????" + JSON.stringify(resp))], message.group);
                else{
                    await bot.sendGroupMessage([Plain("?????????????????????????????????")], message.group);
                    await bot.sendTempMessage([Plain(`[BorrowLivingRoomBot] ???????????????\n?????????(?????????)???${message.sender}`)],roomqq,message.group);
                await bot.sendTempMessage([Plain(`[BorrowLivingRoomBot] ???????????????`)],message.sender,message.group);
                }
                break;
            }
            default: {
                return;
            }
        }
    });

    bot.listen("group");
}

async function getRoomID(cookie: string) {
    let parsed = parseCookie(cookie);
    if (!parsed) throw Error("NO COOKIE");
    let userdata: any = await (await fetch(`https://api.bilibili.com/x/web-interface/nav`,
        {
            headers: { Cookie: parsed.all }
        })).json();
    let roomdata: any = await (await fetch(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${userdata.data.mid}`)).json()
    return roomdata.data.room_id;
}

process.on("uncaughtException", function (err) {
    log.error(err);
})

main();

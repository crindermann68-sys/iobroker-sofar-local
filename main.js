"use strict";
const utils = require("@iobroker/adapter-core");
const net = require("net");

function crc16Modbus(buf) {
    let crc = 0xFFFF;
    for (const b of buf) {
        crc ^= b;
        for (let i = 0; i < 8; i++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1);
    }
    return crc & 0xFFFF;
}
function hex(buf) { return Buffer.from(buf).toString("hex").match(/../g)?.join(" ") || ""; }
function s16(v) { return v & 0x8000 ? v - 0x10000 : v; }
function u32(a,b) { return (((a >>> 0) * 0x100000000) + (b >>> 0)); }

class SofarLocal extends utils.Adapter {
    constructor(options) {
        super({...options, name: "sofar-local"});
        this.socket = null; this.seq = 0; this.running = false; this.pollTimer = null; this.busy = false;
        this.on("ready", () => this.main().catch(err => this.log.error(String(err))));
        this.on("unload", cb => { this.running=false; if(this.pollTimer) clearTimeout(this.pollTimer); if(this.socket) try{this.socket.destroy();}catch(_){} cb(); });
    }
    async setString(id,val){ await this.setStateAsync(id,{val:String(val??""),ack:true}); }
    async setNumber(id,val,dec=1){ const n=Number(val); if(!Number.isFinite(n)) return; await this.setStateAsync(id,{val:Number(n.toFixed(dec)),ack:true}); }
    async ensureState(id,type,def,role="value",unit=null,name=null){
        const existing=await this.getObjectAsync(id);
        const common={name:name||id,type,role,read:true,write:false,def}; if(unit) common.unit=unit;
        if(!existing){ await this.setObjectAsync(id,{type:"state",common,native:{}}); }
        else if(existing.common?.type!==type || (unit && existing.common?.unit!==unit)) {
            await this.setObjectAsync(id,{type:"state",common:{...existing.common,...common},native:existing.native||{}});
        }
    }
    async createStates(){
        const channels=[
            ["verbindung","Verbindung"],["wechselrichter","Wechselrichter"],["photovoltaik","Photovoltaik"],
            ["batterie","Batterie"],["netz","Netz"],["verbrauch","Hausverbrauch"],["energie","Energie"],["rohwerte","Rohdaten"]
        ];
        for (const [id,name] of channels) {
            const existing=await this.getObjectAsync(id);
            if (!existing) await this.setObjectAsync(id,{type:"channel",common:{name},native:{}});
            else if (existing.common?.name!==name) await this.setObjectAsync(id,{type:"channel",common:{...existing.common,name},native:existing.native||{}});
        }
        const defs=[
            ["verbindung.online","boolean",false,"indicator",null,"Verbindung: Online"],
            ["verbindung.lastUpdate","number",0,"value",null,"Letzte Aktualisierung"],
            ["verbindung.lastError","string","","text",null,"Letzter Fehler"],
            ["verbindung.loggerSerial","string",String(this.config.loggerSn||""),"text",null,"Logger-Seriennummer"],
            ["verbindung.lastTx","string","","text",null,"Letzte Anfrage (Hex)"],
            ["verbindung.lastRx","string","","text",null,"Letzte Antwort (Hex)"],
            ["wechselrichter.state","number",0,"value",null,"Gerätestatus"],
            ["photovoltaik.power","number",0,"value","W","PV-Gesamtleistung"],
            ["photovoltaik.mppt1Power","number",0,"value","W","PV1 Leistung"],
            ["photovoltaik.mppt2Power","number",0,"value","W","PV2 Leistung"],
            ["photovoltaik.mppt1Voltage","number",0,"value","V","PV1 Spannung"],
            ["photovoltaik.mppt2Voltage","number",0,"value","V","PV2 Spannung"],
            ["photovoltaik.mppt1Current","number",0,"value","A","PV1 Strom"],
            ["photovoltaik.mppt2Current","number",0,"value","A","PV2 Strom"],
            ["photovoltaik.totalPowerRegister","number",0,"value","W","PV-Leistung laut Gesamtregister"],
            ["batterie.power","number",0,"value","W","Batterieleistung"],
            ["batterie.rawPower","number",0,"value","W","Batterieleistung (Rohwert)"],
            ["batterie.soc","number",0,"value","%","Batterieladezustand (SOC)"],
            ["batterie.voltage","number",0,"value","V","Batteriespannung"],
            ["batterie.current","number",0,"value","A","Batteriestrom"],
            ["batterie.temperature","number",0,"value","°C","Batterietemperatur"],
            ["batterie.soh","number",0,"value","%","Batteriezustand (SOH)"],
            ["batterie.cycles","number",0,"value",null,"Batteriezyklen"],
            ["netz.power","number",0,"value","W","Netzleistung"],
            ["netz.importPower","number",0,"value","W","Netzbezug"],
            ["netz.exportPower","number",0,"value","W","Netzeinspeisung"],
            ["netz.frequency","number",0,"value","Hz","Netzfrequenz"],
            ["netz.voltageL1","number",0,"value","V","Netzspannung L1"],
            ["netz.currentL1","number",0,"value","A","Netzstrom L1"],
            ["verbrauch.power","number",0,"value","W","Hausverbrauch (berechnet)"],
            ["verbrauch.registerPower","number",0,"value","W","Hausverbrauch laut Wechselrichter"],
            ["verbrauch.differenz","number",0,"value","W","Abweichung Berechnung zu Wechselrichter"],
            ["wechselrichter.power","number",0,"value","W","Wechselrichterleistung"],
            ["energie.pvToday","number",0,"value","kWh","PV-Ertrag heute"],
            ["energie.pvTotal","number",0,"value","kWh","PV-Ertrag gesamt"],
            ["energie.loadToday","number",0,"value","kWh","Verbrauch heute"],
            ["energie.loadTotal","number",0,"value","kWh","Verbrauch gesamt"],
            ["energie.importToday","number",0,"value","kWh","Netzbezug heute"],
            ["energie.importTotal","number",0,"value","kWh","Netzbezug gesamt"],
            ["energie.exportToday","number",0,"value","kWh","Einspeisung heute"],
            ["energie.exportTotal","number",0,"value","kWh","Einspeisung gesamt"],
            ["energie.batteryChargeToday","number",0,"value","kWh","Batterieladung heute"],
            ["energie.batteryChargeTotal","number",0,"value","kWh","Batterieladung gesamt"],
            ["energie.batteryDischargeToday","number",0,"value","kWh","Batterieentladung heute"],
            ["energie.batteryDischargeTotal","number",0,"value","kWh","Batterieentladung gesamt"],
            ["rohwerte.lastModbusResponse","string","","text",null,"Letzte Modbus-Antwort (Rohdaten)"],
            ["rohwerte.energyBlock","string","","text",null,"Energieblock (Rohdaten)"]
        ];
        for(const d of defs){
            const [id,type,def,role,unit,name]=d;
            await this.ensureState(id,type,def,role,unit,name);
        }

        // Alle Rohregister vor der ersten Abfrage als echte ioBroker-Objekte anlegen.
        // readRegister() darf erst danach setState() auf diesen IDs ausführen.
        const rawRegisters = [
            [0x0404, "Wechselrichter-Status (Rohwert)"],
            [0x0484, "Netzfrequenz (Rohwert)"],
            [0x0485, "Wechselrichter-Systemleistung (Rohwert)"],
            [0x0488, "Netzleistung PCC (Rohwert)"],
            [0x048D, "Netzspannung L1 (Rohwert)"],
            [0x0492, "Netzstrom L1 (Rohwert)"],
            [0x04AF, "Hausverbrauch Wechselrichter (Rohwert)"],
            [0x0584, "PV1/PV2 (Rohwerte)"],
            [0x05C4, "PV-Gesamtleistung (Rohwert)"],
            [0x0604, "Batterie (Rohwerte)"],
            [0x0684, "PV-Ertrag heute (Rohwert)"],
            [0x0686, "PV-Ertrag gesamt (Rohwert)"],
            [0x068E, "Netzbezug gesamt (Rohwert)"],
            [0x0692, "Einspeisung gesamt (Rohwert)"],
            [0x0694, "Batterieladung gesamt (Rohwert)"],
            [0x069A, "Batterieentladung gesamt (Rohwert)"]
        ];
        for (const [addr, name] of rawRegisters) {
            await this.ensureState(
                `rohwerte.reg_${addr.toString(16).toUpperCase()}`,
                "string",
                "",
                "text",
                null,
                name
            );
        }
    }
    buildModbus(slave,fc,address,quantity){
        const b=Buffer.alloc(6); b[0]=slave&255; b[1]=fc&255; b.writeUInt16BE(address&65535,2); b.writeUInt16BE(quantity&65535,4); const crc=crc16Modbus(b); return Buffer.concat([b,Buffer.from([crc&255,(crc>>>8)&255])]);
    }
    buildV5(modbus){
        const serial=Number(this.config.loggerSn||0); const payloadLen=15+modbus.length; const frame=Buffer.alloc(11+payloadLen+2); let p=0;
        frame[p++]=0xA5; frame.writeUInt16LE(payloadLen,p);p+=2; frame.writeUInt16LE(0x4510,p);p+=2; this.seq=(this.seq+1)&255; frame[p++]=this.seq; frame[p++]=0; frame.writeUInt32LE(serial>>>0,p);p+=4; frame[p++]=2; frame.writeUInt16LE(0,p);p+=2; frame.writeUInt32LE(0,p);p+=4; frame.writeUInt32LE(0,p);p+=4; frame.writeUInt32LE(0,p);p+=4; modbus.copy(frame,p);p+=modbus.length; let sum=0; for(let i=1;i<p;i++) sum=(sum+frame[i])&255; frame[p++]=sum; frame[p]=0x15; return frame;
    }
    parseResponse(buf,seq){
        if(!buf||buf.length<28||buf[0]!==0xA5) return null;
        for(let start=0;start<=buf.length-28;start++){
            if(buf[start]!==0xA5) continue; const plen=buf.readUInt16LE(start+1); const flen=11+plen+2; if(start+flen>buf.length||buf[start+flen-1]!==0x15) continue;
            const control=buf.readUInt16LE(start+3), rseq=buf[start+5], serial=buf.readUInt32LE(start+7); if(control!==0x1510||rseq!==seq) continue;
            let sum=0; for(let i=start+1;i<start+flen-2;i++) sum=(sum+buf[i])&255; const checksumOk=sum===buf[start+flen-2]; const modStart=start+25, modLen=plen-14;
            if(modLen<5||modStart+modLen>start+flen-2) return {error:"V5 response has no usable Modbus frame",raw:buf.subarray(start,start+flen),checksumOk,serial};
            return {control,seq:rseq,serial,checksumOk,modbus:buf.subarray(modStart,modStart+modLen),raw:buf.subarray(start,start+flen)};
        }
        return null;
    }
    async request(fc,address,quantity){
        if (!String(this.config.host || "").trim()) throw new Error("Logger-IP-Adresse ist nicht konfiguriert");
        if (!String(this.config.loggerSn || "").trim()) throw new Error("Logger-Seriennummer ist nicht konfiguriert");
        const modbus=this.buildModbus(Number(this.config.slaveId||1),fc,address,quantity); const frame=this.buildV5(modbus); const seq=this.seq; await this.setString("verbindung.lastTx",hex(frame));
        const timeoutMs=Math.max(2000,Number(this.config.timeoutMs||8000));
        return await new Promise((resolve,reject)=>{
            const socket=new net.Socket(); this.socket=socket; let chunks=[]; let timer;
            const cleanup=()=>{if(timer)clearTimeout(timer);socket.removeAllListeners();try{socket.destroy();}catch(_){}if(this.socket===socket)this.socket=null;};
            const fail=e=>{cleanup();reject(e)}; timer=setTimeout(()=>fail(new Error(`Timeout: keine Antwort auf FC${fc} Register 0x${address.toString(16).toUpperCase()}`)),timeoutMs);
            socket.setNoDelay(true); socket.on("error",fail); socket.on("data",data=>{chunks.push(Buffer.from(data));const all=Buffer.concat(chunks);void this.setString("verbindung.lastRx",hex(all));const r=this.parseResponse(all,seq);if(r){cleanup();resolve(r);}}); socket.connect(Number(this.config.port||8899),String(this.config.host||""),()=>socket.write(frame));
        });
    }
    parseModbus(r){
        if(r.error)throw new Error(r.error); const m=r.modbus; if(m.length<5)throw new Error("Modbus-Antwort zu kurz"); const calc=crc16Modbus(m.subarray(0,m.length-2)),got=m.readUInt16LE(m.length-2); if(calc!==got)throw new Error("Modbus CRC ungültig"); const fc=m[1]; if(fc&128)throw new Error(`Modbus Exception FC${fc&127}: Code ${m[2]}`); const bc=m[2]; if(bc+5>m.length)throw new Error("Modbus ByteCount passt nicht"); const vals=[];for(let i=0;i<bc;i+=2)vals.push(m.readUInt16BE(3+i));return {fc,values:vals,raw:m};
    }
    async readRegister(addr, qty=1, label="") {
        // SOFAR G3 over LSW3 can answer FC3 or FC4 depending on firmware/register.
        // Try FC3 first, then FC4. A short pause between requests avoids overrunning the logger.
        let lastErr = null;
        for (const fc of [3, 4]) {
            try {
                const r = await this.request(fc, addr, qty);
                const p = this.parseModbus(r);
                await this.setString("rohwerte.lastModbusResponse", hex(p.raw));
                await this.setString(`rohwerte.reg_${addr.toString(16).toUpperCase()}`, p.values.join(","));
                this.log.info(`${label || "Register"} 0x${addr.toString(16).toUpperCase()}: FC${fc} OK values=${p.values.join(",")}`);
                await new Promise(resolve => setTimeout(resolve, 300));
                return p.values;
            } catch (e) {
                lastErr = e;
                this.log.debug(`${label || "Register"} 0x${addr.toString(16).toUpperCase()} FC${fc}: ${e.message}`);
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }
        throw lastErr || new Error(`Register 0x${addr.toString(16).toUpperCase()} konnte nicht gelesen werden`);
    }
    async optionalRegister(addr, qty=1, label="") {
        try { return await this.readRegister(addr, qty, label); }
        catch (e) { this.log.warn(`${label || "Register"} 0x${addr.toString(16).toUpperCase()} nicht verfügbar: ${e.message}`); return null; }
    }
    async pollData(){
        // Proven SOFAR G3/HYD register map. Start with the individual registers
        // already confirmed on this exact LSW3 logger in adapter 0.3.3.
        const state = await this.readRegister(0x0404,1,"Wechselrichter-Status");
        await this.setNumber("wechselrichter.state", state[0], 0);

        const hz = await this.optionalRegister(0x0484,1,"Netzfrequenz");
        if (hz) await this.setNumber("netz.frequency", hz[0]/100,2);

        const invPower = await this.optionalRegister(0x0485,1,"Wechselrichter-Systemleistung");
        if (invPower) await this.setNumber("wechselrichter.power", s16(invPower[0])*10,0);

        const grid = await this.readRegister(0x0488,1,"Netzleistung PCC");
        const gridPower = s16(grid[0]) * -10;
        await this.setNumber("netz.power",gridPower,0);
        await this.setNumber("netz.importPower",Math.max(0,gridPower),0);
        await this.setNumber("netz.exportPower",Math.max(0,-gridPower),0);

        const gridV = await this.optionalRegister(0x048D,1,"Netzspannung");
        if (gridV) await this.setNumber("netz.voltageL1",gridV[0]/10,1);
        const gridI = await this.optionalRegister(0x0492,1,"Netzstrom L1");
        if (gridI) await this.setNumber("netz.currentL1",gridI[0]/100,2);

        const load = await this.optionalRegister(0x04AF,1,"Hausverbrauch laut Wechselrichter");
        if (load) await this.setNumber("verbrauch.registerPower",s16(load[0])*10,0);

        const pv = await this.readRegister(0x0584,6,"PV1/PV2");
        await this.setNumber("photovoltaik.mppt1Voltage",pv[0]/10,1);
        await this.setNumber("photovoltaik.mppt1Current",pv[1]/100,2);
        await this.setNumber("photovoltaik.mppt1Power",pv[2]*10,0);
        await this.setNumber("photovoltaik.mppt2Voltage",pv[3]/10,1);
        await this.setNumber("photovoltaik.mppt2Current",pv[4]/100,2);
        await this.setNumber("photovoltaik.mppt2Power",pv[5]*10,0);
        await this.setNumber("photovoltaik.power",(pv[2]+pv[5])*10,0);

        const pvTotal = await this.optionalRegister(0x05C4,1,"PV-Gesamtleistung");
        if (pvTotal) await this.setNumber("photovoltaik.totalPowerRegister",pvTotal[0]*100,0);

        const bat = await this.readRegister(0x0604,7,"Batterie");
        await this.setNumber("batterie.voltage",bat[0]/10,1);
        await this.setNumber("batterie.current",s16(bat[1])/100,2);
        // SOFAR: positive battery power = charging, negative = discharging.
        // Adapter convention: positive = discharge, negative = charge.
        const batPower = s16(bat[2]) * -10;
        await this.setNumber("batterie.rawPower",s16(bat[2])*10,0);
        await this.setNumber("batterie.power",batPower,0);
        await this.setNumber("batterie.temperature",s16(bat[3]),1);
        await this.setNumber("batterie.soc",bat[4],0);
        await this.setNumber("batterie.soh",bat[5],0);
        await this.setNumber("batterie.cycles",bat[6],0);

        // Energiebilanz: Hausverbrauch = PV + Batterieleistung (Entladung positiv) + Netzleistung (Bezug positiv).
        // Damit wird der zentrale Verbrauchswert unabhängig vom optionalen Wechselrichter-Register berechnet.
        const calculatedLoad = (pv[2] + pv[5]) * 10 + batPower + gridPower;
        await this.setNumber("verbrauch.power", Math.max(0, calculatedLoad), 0);
        if (load) {
            const registerLoad = s16(load[0]) * 10;
            await this.setNumber("verbrauch.differenz", calculatedLoad - registerLoad, 0);
        } else {
            await this.setNumber("verbrauch.differenz", 0, 0);
        }

        // Energy registers are read individually because some HYD firmware versions
        // reject large blocks. The key total PV energy register is 0x0686.
        const pvToday = await this.optionalRegister(0x0684,1,"PV-Ertrag heute");
        const pvTotalE = await this.optionalRegister(0x0686,2,"PV-Ertrag gesamt");
        if (pvToday) await this.setNumber("energie.pvToday",pvToday[0]/10,1);
        if (pvTotalE) await this.setNumber("energie.pvTotal",u32(pvTotalE[0],pvTotalE[1])/10,1);
        const imp = await this.optionalRegister(0x068E,2,"Netzbezug gesamt");
        if (imp) await this.setNumber("energie.importTotal",u32(imp[0],imp[1])/10,1);
        const exp = await this.optionalRegister(0x0692,2,"Einspeisung gesamt");
        if (exp) await this.setNumber("energie.exportTotal",u32(exp[0],exp[1])/10,1);
        const batCharge = await this.optionalRegister(0x0694,2,"Batterieladung gesamt");
        if (batCharge) await this.setNumber("energie.batteryChargeTotal",u32(batCharge[0],batCharge[1])/10,1);
        const batDis = await this.optionalRegister(0x069A,2,"Batterieentladung gesamt");
        if (batDis) await this.setNumber("energie.batteryDischargeTotal",u32(batDis[0],batDis[1])/10,1);
    }
    async main(){await this.createStates();this.running=true;this.log.info(`SOFAR Lokal 0.4.3 – ${this.config.host||"<nicht konfiguriert>"}:${this.config.port||8899}`);this.log.info(`LSW3/SOFAR: SN=${this.config.loggerSn||"<nicht konfiguriert>"}, 9600 8N1, TCP-Server 8899, Sofar_G3`);this.log.info("Nur-Lesen: SOFAR G3/HYD Register über LSW3. FC3/FC4 mit Rückfall und Diagnose.");await this.poll();}
    async poll(){if(!this.running||this.busy)return;this.busy=true;try{await this.pollData();await this.setStateAsync("verbindung.online",{val:true,ack:true});await this.setStateAsync("verbindung.lastUpdate",{val:Date.now(),ack:true});await this.setString("verbindung.lastError","");this.log.info("SOFAR-Daten erfolgreich gelesen.");}catch(e){await this.setStateAsync("verbindung.online",{val:false,ack:true});await this.setString("verbindung.lastError",e.message);this.log.error(`Abfrage fehlgeschlagen: ${e.message}`);}finally{this.busy=false;if(this.running)this.pollTimer=setTimeout(()=>this.poll(),Math.max(10000,Number(this.config.pollMs||15000)));}}
}
if(require.main!==module)module.exports=options=>new SofarLocal(options);else(()=>new SofarLocal())();

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(express.json());
const origins = (process.env.CORS_ORIGIN||"").split(",").map(s=>s.trim()).filter(Boolean);
app.use(cors({ origin:(o,cb)=>cb(null,!o||origins.includes(o)), credentials:true }));

const http = createServer(app);
const io = new Server(http, { cors:{ origin: origins } });

// in-memory store
const store = { drops:[], claims:[] };
const uid = () => Math.random().toString(36).slice(2);

// endpoints
app.get("/api/drops",(req,res)=>res.json(store.drops.filter(d=>d.is_active!==false)));
app.post("/api/drops",(req,res)=>{
  const d={ id:uid(), title:req.body.title||"Untitled", description:req.body.description||"",
    lat:+req.body.lat, lng:+req.body.lng, radius_m:+(req.body.radius_m||25),
    reward_type:req.body.reward_type||"points", reward_value:+(req.body.reward_value||10),
    is_active:req.body.is_active!==false, created_at:new Date().toISOString() };
  store.drops.push(d); io.emit("drop:create", d); res.json(d);
});
app.patch("/api/drops/:id",(req,res)=>{
  const i=store.drops.findIndex(x=>x.id===req.params.id);
  if(i<0) return res.status(404).json({error:"not found"});
  store.drops[i] = { ...store.drops[i], ...req.body };
  io.emit("drop:update", store.drops[i]); res.json(store.drops[i]);
});
const toRad=d=>d*Math.PI/180;
const distM=(a,b,c,d)=>{const R=6371000,dLat=toRad(c-a),dLng=toRad(d-b);
  const A=Math.sin(dLat/2)**2+Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(A));};
app.post("/api/claims",(req,res)=>{
  const {dropId,userId,user_lat,user_lng}=req.body||{};
  const drop=store.drops.find(x=>x.id===dropId && x.is_active!==false);
  if(!drop) return res.status(400).json({error:"inactive or missing drop"});
  const distance=distM(+user_lat,+user_lng,drop.lat,drop.lng);
  if(distance>(drop.radius_m||25)+10) return res.status(400).json({error:"too far",distance});
  if(store.claims.find(c=>c.dropId===dropId&&c.userId===userId))
    return res.status(409).json({error:"already claimed"});
  const c={ id:uid(), dropId, userId:userId||"web-user", user_lat:+user_lat, user_lng:+user_lng,
            claimed_at:new Date().toISOString() };
  store.claims.push(c); io.emit("claim:create", c); res.json({ok:true,claim:c});
});
app.get("/api/stats/overview",(req,res)=>res.json({drops:store.drops.length,claims:store.claims.length,last_claim:store.claims.at(-1)||null}));

const PORT = process.env.PORT || 3001;
http.listen(PORT, ()=>console.log("MoveServer on :"+PORT));

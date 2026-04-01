import axios from "axios";
import * as cheerio from "cheerio";
import https from "https";

async function run() {
  try {
    const res = await axios.get("https://www.vitrasa.es:8002/lineas-y-horarios/detalle-de-linea?linea=11", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }) // In case 8002 has a self-signed cert
    });
    
    const $ = cheerio.load(res.data);
    
    console.log("Title:", $("title").text());
    
    const lists = [];
    $(".stop-list, ul.stops, .paradas").each((i, el) => {
      // Find stops containers
      lists.push(i);
    });
    console.log("Found stop containers:", lists.length);
    
    // Find generic data-id attributes
    const ida = [];
    $("[data-id]").slice(0, 5).each((i, el) => {
      ida.push($(el).attr("data-id"));
    });
    console.log("Ids demo:", ida);
    
  } catch (e) {
    console.error("Error:", e.message);
  }
}
run();

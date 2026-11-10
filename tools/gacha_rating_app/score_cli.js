'use strict';
const {scoreCharacter}=require('./character_score.js');
let data='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{data+=chunk;if(data.length>8*1024*1024)process.exit(2);});
process.stdin.on('end',()=>{try{process.stdout.write(JSON.stringify(scoreCharacter(JSON.parse(data))));}catch(e){process.stderr.write(e.message);process.exitCode=1;}});

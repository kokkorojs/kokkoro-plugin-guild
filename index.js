const low = require('lowdb');
const FileAsync = require('lowdb/adapters/FileAsync');
const axios = require('axios');

const { join } = require('path');
const { existsSync } = require('fs');
const { writeFile, mkdir } = require('fs/promises');
const { getOrder, getOption, section } = require('kokkoro');

let db;

const ALL_BLOOD = {
  bl: [
    [6000000, 8000000, 10000000, 12000000, 15000000],
    [6000000, 8000000, 10000000, 12000000, 15000000],
    [7000000, 9000000, 13000000, 15000000, 20000000],
    [15000000, 16000000, 18000000, 19000000, 20000000],
    [15000000, 16000000, 18000000, 19000000, 20000000],
  ],
  tw: [
    [6000000, 8000000, 10000000, 12000000, 15000000],
    [6000000, 8000000, 10000000, 12000000, 15000000],
    [12000000, 14000000, 17000000, 19000000, 22000000],
    [19000000, 20000000, 23000000, 25000000, 27000000],
    [85000000, 90000000, 95000000, 100000000, 110000000],
  ],
  jp: [
    [6000000, 8000000, 10000000, 12000000, 15000000],
    [6000000, 8000000, 10000000, 12000000, 15000000],
    [12000000, 14000000, 17000000, 19000000, 22000000],
    [19000000, 20000000, 23000000, 25000000, 27000000],
    [95000000, 100000000, 110000000, 120000000, 130000000],
  ]
};
const SCORE_RATE = [
  [1.2, 1.2, 1.3, 1.4, 1.5],
  [1.6, 1.6, 1.8, 1.9, 2.0],
  [2.0, 2.0, 2.4, 2.4, 2.6],
  [3.5, 3.5, 3.7, 3.8, 4.0],
  [3.5, 3.5, 3.7, 3.8, 4.0],
];

const boss_char = ['一', '二', '三', '四', '五'];

// 初始化
function init(event, option) {
  const { raw_message } = event;

  let server;
  const guild = raw_message.slice(2, 4);

  switch (guild) {
    case '国服':
      server = 'bl';
      break;

    case '台服':
      server = 'tw';
      break;

    case '日服':
      server = 'jp';
      break;
  }

  if (option.server[0] === server) return event.reply(`当前群聊已设置 ${guild} 公会，请不要重复修改`, true);

  event.raw_message = `>guild server ${server}`;
}

// 报刀
function fight(event, option) {
  const { group_id } = event;
  const battle = getBattle(group_id);

  // 当前是否开启会战
  if (!battle || getLastUpdate(battle.update) > 3) {
    return event.reply('当前没有会战信息，可让管理发送 "发起会战" 初始化数据', true);
  }

  const { raw_message } = event;
  const [server] = option.server;

  // 是否是国服
  if (/^\d/.test(raw_message) && server === 'bl') {
    return event.reply(`当前群聊设置的是国服公会，无法指定 boss 报刀`, true);
  }

  const { blood, history, syuume } = battle;
  const { sender } = event;
  const { user_id, nickname } = sender;
  const { datetime, today_date, yesterday_date } = getDateInfo();

  const [date, time] = datetime.split(' ');
  const [hour, minute, seconds] = time.split(':');

  // 兰德索尔时间
  let randosoru_date = today_date;

  // 如果在次日 5 点之前报刀则依然写入到前一天 key
  if (parseInt(hour) < 5 && datetime.startsWith(today_date)) {
    randosoru_date = yesterday_date;
  }

  // 判断当日已出多少刀
  let number = db
    .get(group_id)
    .last()
    .get(`history.${randosoru_date}`)
    .filter({ user_id })
    .last()
    .get('number', 0)
    .value()

  if (number === 3 && raw_message.indexOf('连报') === -1) {
    return event.reply(`你今天已经出完3刀啦，请不要重复提交数据，如有多个小号，可使用 "连报" 指令`, true);
  }

  let kill = false;
  let damage = Number(raw_message.match(/(?<=(报刀|代报|连报)).*/g));
  let boss = Number(raw_message.match(/\d\s?(?=(报刀|代报|尾刀|连报))/g));

  // 未指定 boss 则选取存活的第一个 boss
  if (!boss) {
    for (let i = 0; i < 5; i++) {
      if (blood[i]) {
        boss = i + 1;
        boss_index = i;
        break;
      }
    }
  } else {
    boss_index = boss - 1;
  }

  // 是否是尾刀
  if (damage) {
    number = parseInt(number) + 1;
  } else {
    kill = true;
    number = number + 0.5;
    damage = blood[boss_index];
  }

  // boss 血量为空
  if (!blood[boss_index]) {
    return event.reply(`${boss_char[boss_index]}王都没了，你报啥呢？`, true);
  }

  // 伤害溢出
  if (damage > blood[boss_index]) {
    return event.reply(`伤害值超出 boss 剩余血量，若以斩杀 boss 请使用「尾刀」指令`, true);
  }

  const fight_info = {
    datetime, syuume, boss, number, damage, user_id, nickname,
    remark: `${nickname} 对${boss_char[boss_index]}王造成了 ${damage} 点伤害`,
  }
  blood[boss_index] -= damage;

  if (!history[randosoru_date]) {
    db
      .get(group_id)
      .last()
      .set(`history.${randosoru_date}`, [])
      .write()
  }

  db
    .get(group_id)
    .last()
    .set('update', +new Date)
    .set('blood', blood)
    .get(`history.${randosoru_date}`)
    .push(fight_info)
    .write()
    .then(() => {
      state(event, option);
      // 斩杀 boss 并且是国服则开始 at 成员
      kill && server === 'bl' && atMembers(event, boss);
    })
}

// 代报
function stead(event, option) {
  const { message, user_id } = event;
  const { qq: stead_id, text } = message[0];

  if (stead_id === user_id) {
    return event.reply(`不能自己跟自己代报 (╯▔皿▔)╯`, true);
  }

  const stead_nickname = text.replace('@', '');

  event.raw_message = message[1].text.trim();
  event.sender.user_id = stead_id;
  event.sender.nickname = stead_nickname;

  fight(event, option);
}

// at 预约成员
function atMembers(event, boss) {
  if (boss === 5) {
    boss = 0;
  }

  const message = [];
  const group_id = event.group_id;
  const members = getBattle(group_id).reserve[boss];

  for (const qq in members) {
    message.push(section.at(qq));
    !members[qq].persistence && delete members[qq];
  }

  if (message.length) {
    db
      .get(`${group_id}.reserve[${boss}]`)
      .set(members)
      .write()
      .then(() => {
        message.push(` 到${boss_char[boss]}王啦~`);
        event.reply(message);
      })
  }
}

// 状态
function state(event, option) {
  const { group_id } = event;
  const battle = getBattle(group_id);

  // 当前是否开启会战
  if (!battle || getLastUpdate(battle.update) > 3) {
    return event.reply('当前没有会战信息，可让管理发送 "发起会战" 初始化数据', true);
  }

  let state;
  let stage;
  let boss = 1;
  let next = true;
  let { blood, update, syuume } = battle;
  const [server] = option.server;

  // 是否进入下一周目
  for (let i = 0; i < 5; i++) {
    if (blood[i]) {
      boss = i + 1;
      next = false;
      break;
    }
  }

  if (next) {
    ++syuume;
    blood = getBlood(server, syuume);

    db
      .get(group_id)
      .last()
      .set('blood', blood)
      .set('syuume', syuume)
      .write()
      .then(() => {
        const message = [`所有 boss 已被斩杀，开始进入 ${syuume} 周目`];

        // 非国服在进入下一周目时 at 所有成员
        server !== 'bl' && message.unshift(section.at('all'));
        event.reply(message);
      })
  }
  stage = getStage(syuume);

  if (server === 'bl') {
    state = `${syuume} 周目 ${stage} 阶段 ${boss_char[boss - 1]} 王\nboss 信息:\n\t${blood[boss - 1]} / ${getBlood(server, syuume, boss)}`;
  } else {
    const max_blood = getBlood(server, syuume);
    state = `${syuume} 周目 ${stage} 阶段\nboss 信息:`;

    for (let i = 0; i < 5; i++) {
      state += `\n\t${boss_char[i]}王 ${blood[i]}/${max_blood[i]}`;
    }
  }

  const { datetime } = getDateInfo(update);

  event.reply(`当前状态:\n\t${state}\n更新时间:\n\t${datetime}`);
}

// 发起
function start(event, option) {
  const { group_id } = event;
  const battle = getBattle(group_id);

  // 当前是否开启会战
  if (battle && getLastUpdate(battle.update) < 3) {
    return event.reply('该群聊在 3 天内发起过会战，请不要重复提交', true);
  }

  const [server] = option.server;
  const blood = getBlood(server, 1);
  const default_battle = {
    update: +new Date, blood, syuume: 1,
    reserve: [{}, {}, {}, {}, {}], history: {},
  }

  db
    .get(group_id)
    .push(default_battle)
    .write()
    .then(() => {
      let state;

      if (server === 'bl') {
        state = `1 周目 1 阶段 一王\nboss 信息:\n\t${blood[0]} / ${blood[0]}`;
      } else {
        state = '1 周目 1 阶段\nboss 信息:';

        for (let i = 0; i < 5; i++) {
          state += `\n\t${boss_char[i]}王 ${blood[i]} / ${blood[i]}`;
        }
      }

      const { datetime } = getDateInfo();

      event.reply(`当前状态:\n\t${state}\n更新时间:\n\t${datetime}`);
    })
}

// 中止
function stop(event, option) {
  const { group_id } = event;
  const battle = getBattle(group_id);

  // 当前是否开启会战
  if (battle && getLastUpdate(battle.update) > 3) {
    return event.reply('当前群聊在 3 天内未发起过会战', true);
  }

  db
    .get(group_id)
    .pop()
    .write()
    .then(() => {
      event.reply(`当前会战已中止，所有数据清空完毕`);
    })
}

// 预约
function reservation(event, option) {
  const { group_id, raw_message } = event;
  const [server] = option.server;
  const battle = getBattle(group_id);

  // 当前是否开启会战
  if (!battle || getLastUpdate(battle.update) > 3) {
    return event.reply('当前没有会战信息，可让管理发送 "发起会战" 初始化数据', true);
  }

  // 是否是非国服
  if (server !== 'bl') {
    return event.reply(`当前群聊设置的是非国服公会，无须预约 boss`, true);
  }

  const boss = Number(raw_message.charAt(raw_message.length - 1));
  const boss_index = boss - 1;

  // 未传入 boss 则直接发送预约列表
  if (isNaN(boss)) {
    let message = '';

    for (let i = 0; i < 5; i++) {
      const reserve = Object.entries(battle.reserve[i]);

      if (!reserve.length) {
        message += `暂无\n`;
        continue;
      }

      const members = reserve.map(item => `${item[1].persistence ? '*' : ''}${item[1].name}`).join(', ');

      message += `${boss_char[i]}王：\n\t${members}\n`;
    }

    return event.reply(message);
  }

  const { user_id, sender } = event;
  const { nickname, card } = sender;

  // 判断是否预约
  if (battle.reserve[boss_index][user_id]) {
    return event.reply(`你已经预约过${boss_char[boss_index]}王，请勿重复预约`, true);
  }

  const user_info = {
    // 用户名称
    name: card ? card : nickname,
    // 是否持久化（boss 斩杀后不清除预约信息）
    persistence: raw_message.startsWith('*'),
  }

  db
    .get(`${group_id}`)
    .last()
    .set(`reserve[${boss_index}][${user_id}]`, user_info)
    .write()
    .then(() => {
      event.reply(`预约成功`, true);
    })
}

// 爽约
function gugugu(event, option) {
  const { group_id, raw_message } = event;
  const [server] = option.server;
  const battle = getBattle(group_id);

  // 当前是否开启会战
  if (!battle || getLastUpdate(battle.update) > 3) {
    return event.reply('当前没有会战信息，可让管理发送 "发起会战" 初始化数据', true);
  }

  // 是否是非国服
  if (server !== 'bl') {
    return event.reply(`当前群聊设置的是非国服公会，无须预约 boss`, true);
  }

  const boss = Number(raw_message.charAt(raw_message.length - 1));
  const boss_index = boss - 1;

  if (isNaN(boss)) {
    return event.reply(`请指定需要取消预约的 boss`);
  }

  const { user_id } = event;

  // 判断是否预约
  if (!battle.reserve[boss_index][user_id]) {
    return event.reply(`你没有预约过${boss_char[boss_index]}王，无法取消预约`, true);
  }

  const members = battle.reserve[boss_index];
  delete members[user_id]

  db
    .get(`${group_id}`)
    .last()
    .set(`reserve[${boss_index}]`, members)
    .write()
    .then(() => {
      event.reply(`已取消预约`, true);
    })
}

// 修改 boss 状态
function change(event, option) {
  const { group_id, raw_message } = event;
  const battle = getBattle(group_id);
  const [server] = option.server;

  // 当前是否开启会战
  if (!battle || getLastUpdate(battle.update) > 3) {
    return event.reply('当前没有会战信息，可让管理发送 "发起会战" 初始化数据', true);
  }

  const change_info = { syuume: '周目', boss: 'boss', blood: '血量' }

  for (const item in change_info) {
    const index = raw_message.indexOf(change_info[item]);

    change_info[item] = index === -1 ? null : parseInt(raw_message.slice(index + change_info[item].length));
  }

  const syuume = !change_info.syuume ? battle.syuume : change_info.syuume;
  const blood = battle.blood;

  // 未指定 boss 但指定了血量，默认选取第一个存活的 boss
  if (!change_info.boss && change_info.blood) {
    for (let i = 0; i < 5; i++) {
      const current_blood = blood[i];

      if (current_blood) {
        change_info.boss = i + 1;
        break;
      }
    }
  }

  // 如果只指定 boss 血量则设置满血
  if (change_info.boss && !change_info.blood) {
    change_info.blood = getBlood(server, syuume, change_info.boss);
  }

  if (change_info.blood) {
    // 判断是否为国服
    const boss_index = change_info.boss - 1;
    const current_blood = change_info.blood;

    if (server === 'bl') {
      const max_blood = getBlood(server, syuume);

      for (let i = 0; i < 5; i++) {
        switch (true) {
          case i < boss_index:
            blood[i] = 0;
            break;

          case i > boss_index:
            blood[i] = max_blood[i];
            break;

          default:
            blood[i] = current_blood;
            break;
        }
      }
    } else {
      blood[boss_index] = current_blood;
    }
  }

  db
    .get(group_id)
    .last()
    .set('update', +new Date)
    .set('blood', blood)
    .set('syuume', syuume)
    .write()
    .then(() => {
      state(event, option);
    })
}

// 分数线
function score(event, option) {
  const [server] = option.server;

  if (server !== 'bl') {
    return event.reply(`该功能仅支持国服，日台服没有相关接口，如果有可以联系 yuki 添加或者提 pr`, true);
  }

  axios
    .get(`https://tools-wiki.biligame.com/pcr/getTableInfo?type=subsection`)
    .then(response => {
      let message = '';
      for (const item of response.data) {
        let { rank, clan_name, damage } = item;
        damage = damage / 100000;
        const { syuume, boss } = parseScore(damage);

        message += `排名：${rank}\n公会：${clan_name}\n周目：${syuume}\nboss：${boss}\n分数：${damage}\n---------------\n`;
      }

      message
        ? event.reply(message)
        : event.reply('当月未进行会战，无法获取分数线数据', true);
    })
    .catch(error => {
      event.reply(error.message)
    })
}

// 排名
function rank(event, option) {
  const { raw_message } = event;
  const [, name, leader] = raw_message.split(' ');
  const [server] = option.server;

  if (server !== 'bl') {
    return event.reply(`该功能仅支持国服，日台服没有相关接口，如果有可以联系 yuki 添加或者提 pr`, true);
  }

  axios
    .get(`https://tools-wiki.biligame.com/pcr/getTableInfo?type=search&search=${encodeURI(name)}&page=0`)
    .then(response => {
      const { data: rank_info } = response;
      let message = '';

      if (leader) {
        for (const item of rank_info) {
          let { rank, clan_name, leader_name, damage } = item;
          damage = damage / 100000;
          const { syuume, boss } = parseScore(damage);

          if (leader_name === leader) {
            message += `排名：${rank}\n公会：${clan_name}\n会长：${leader_name}\n周目：${syuume}\nboss：${boss}\n分数：${damage}\n---------------\n`;
          }
        }
      } else {
        if (rank_info.length > 3) rank_info.length = 3;

        for (let i = 0; i < rank_info.length; i++) {
          let { rank, clan_name, leader_name, damage } = rank_info[i];
          damage = damage / 100000;
          const { syuume, boss } = parseScore(damage);

          message += `排名：${rank}\n公会：${clan_name}\n会长：${leader_name}\n周目：${syuume}\nboss：${boss}\n分数：${damage}\n---------------\n`;
        }
        message += '\n你未指定会长，最多显示前 3 条同名公会数据'
      }
      message
        ? event.reply(message)
        : event.reply('没有当前公会的相关信息');
    })
    .catch(error => {
      event.reply(error.message)
    })
}

function getScore(stage, boss) {
  const blood = ALL_BLOOD.bl[stage - 1][boss - 1];
  const rate = SCORE_RATE[stage - 1][boss - 1];

  return blood * rate;
}

function getAllScore(stage) {
  let score = 0;

  for (i = 0; i < 5; i++) {
    score += ALL_BLOOD.bl[stage - 1][i] * SCORE_RATE[stage - 1][i];
  }

  return score;
}

function parseScore(score, syuume = 1, boss = 1) {
  const stage = getStage(syuume);
  const all_score = getAllScore(stage);

  if (all_score < score) {
    return parseScore(score - all_score, ++syuume);
  } else {
    const current_score = getScore(stage, boss);

    if (current_score < score) return parseScore(score - current_score, syuume, ++boss);
  }

  const score_info = { syuume, boss };
  return score_info;
}

// 再你妈的见
// function goodBye(event, option) {
//   const [server] = option.server;

//   if (server !== 'bl') {
//     return event.reply(`该功能仅支持国服，日台服没有相关接口，如果有可以联系 yuki 添加或者提 pr`, true);
//   }

//   axios.get('https://wiki.biligame.com/pcr/Clan/goodbye')
//     .then(response => {
//       const { posts } = response;
//       const current_post = posts[0];


//     })
//     .catch(error => {
//       event.reply(error.message);
//     })
// }

/**
 * 获取当前阶段
 * 
 * 一阶段  1 ~  3
 * 二阶段  4 ~ 10
 * 三阶段 11 ~ 34
 * 四阶段 35 ~ 44
 * 五阶段 45 ~ 
 */
function getStage(syuume) {
  let stage;

  switch (true) {
    case syuume <= 3:
      stage = 1;
      break;
    case syuume <= 10:
      stage = 2;
      break;
    case syuume <= 34:
      stage = 3;
      break;
    case syuume <= 44:
      stage = 4;
      break;
    default:
      stage = 5;
      break;
  }

  return stage;
}

// 获取会战信息
function getBattle(group_id) {
  let battle;

  if (db.has(group_id).value()) {
    battle = db.get(group_id).last().value();
  } else {
    db
      .set(group_id, [])
      .write()
  }

  return battle;
}

// 获取最后更新时间距离当前时间的天数
function getLastUpdate(timestamp) {
  const day = 60 * 60 * 24;
  const second = (new Date - timestamp) / 1000;

  return (second / day).toFixed(1);
}

// 数字添加 0
function addZero(number) {
  return number < 10 ? '0' + number : number.toString();
}

// 获取当前时间
function getDateInfo(timestamp) {
  const date = !timestamp ? new Date() : new Date(timestamp);
  const year = date.getFullYear();
  const month = addZero(date.getMonth() + 1);
  const today = addZero(date.getDate());
  const yesterday = addZero(date.getDate() - 1);
  const hour = addZero(date.getHours());
  const minute = addZero(date.getMinutes());
  const seconds = addZero(date.getSeconds());

  const today_date = `${year}/${month}/${today}`;
  const yesterday_date = `${year}/${month}/${yesterday}`;
  const datetime = `${year}/${month}/${today} ${hour}:${minute}:${seconds}`;

  return { datetime, today_date, yesterday_date };
}

// 获取 boss 血量信息
function getBlood(server, syuume, boss) {
  const stage = getStage(syuume);
  const blood = [...ALL_BLOOD[server][stage - 1]];

  return !boss ? blood : blood[boss - 1];
}

// 映射 json
async function mapping(group_id) {
  const db_path = join(__workname, `/data/guild/${group_id}.json`);

  !existsSync(join(__workname, `/data/guild`)) && await mkdir(join(__workname, `/data/guild`));
  !existsSync(db_path) && await writeFile(db_path, '');

  const adapter = new FileAsync(db_path);
  db = await low(adapter);
}

module.exports = class Guild {
  constructor(bot) {
    this.bot = bot;
    this.option = {
      server: ['none', 'bl', 'tw', 'jp'],
    };
    this.orders = [
      { func: init, regular: /^设置(国|台|日)服(公|工)会$/ },
      { func: start, regular: /^(开启|发起)会战$/ },
      { func: stop, regular: /^中止会战$/ },
      { func: state, regular: /^状态$/ },
      { func: score, regular: /^分数线$/ },
      { func: rank, regular: /^查询(排名|公会)[\s][\S]+([\s][\S]+)?$/ },
      { func: fight, regular: /(^[1-5]?\s?(报刀|连报)\s?[1-9]\d*$|^[1-5]?\s?尾刀$)/ },
      { func: stead, regular: /^@.*\s?[1-5]?\s?\u4EE3\u62A5\s?\d*$/ },
      { func: reservation, regular: /^\*?预约[\s]?[1-5]?$/ },
      { func: gugugu, regular: /^取消预约[\s]?[1-5]?$/ },
      { func: change, regular: /^((\u5468\u76EE|boss|\u8840\u91CF)\s?([1-9]\d*|0)\s?){1,3}$/ },
    ];
  }

  onInit() {
    mapping(this.bot.uin);
  }

  onGroupMessage(event) {
    const raw_message = event.raw_message;
    const option = getOption(event);
    const order = getOrder(this.orders, raw_message);
    const [server] = option.server;

    if (!order || !option.apply) return;
    if (server !== 'none' || raw_message.startsWith('设置')) {
      order.call(this, event, option);
    } else {
      event.reply(`检测到当前群聊未定义游戏服务器，在使用会战功能前请先初始化`);
    }
  }
}

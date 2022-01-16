const low = require('lowdb');
const FileAsync = require('lowdb/adapters/FileAsync');
const axios = require('axios');

const { join } = require('path');
const { existsSync } = require('fs');
const { writeFile, mkdir } = require('fs/promises');
const { checkCommand, getOption, } = require('kokkoro-core');

let db;
const db_path = join(__workname, `/data/db/guild.json`);
const adapter = new FileAsync(db_path);

// #region 
(async () => {
  db = await low(adapter);

  !existsSync(join(__workname, `/data/db`)) && await mkdir(join(__workname, `/data/db`));
  !existsSync(db_path) && await writeFile(db_path, '');
})();
// #endregion

const all_blood = {
  bl: [
    [6000000, 8000000, 10000000, 12000000, 15000000],
    [6000000, 8000000, 10000000, 12000000, 15000000],
    [7000000, 9000000, 12000000, 14000000, 17000000],
    [7000000, 9000000, 12000000, 14000000, 17000000],
    [7000000, 9000000, 12000000, 14000000, 17000000],
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
  const [date, time] = getCurrentDate().split(' ');

  // 判断当日已出多少刀
  let number = db
    .get(group_id)
    .last()
    .get(`history.${date}`)
    .filter({ user_id })
    .last()
    .get('number', 0)
    .value()

  if (number === 3) {
    return event.reply(`你今天已经出完3刀啦，请不要重复提交数据`, true);
  }

  let damage = Number(raw_message.match(/(?<=报刀).*/g));
  let boss = Number(raw_message.match(/\d\s?(?=(报刀|尾刀))/g));

  // 未指定 boss 则选取存活的第一个 boss
  if (!boss) {
    for (let i = 0; i < 5; i++) {
      if (blood[i]) {
        boss = i + 1;
        break;
      }
    }
  }

  // 是否是尾刀
  if (damage) {
    number = parseInt(number) + 1;
  } else {
    number = number + 0.5;
    damage = blood[boss - 1];
  }

  // boss 血量为空
  if (!blood[boss - 1]) {
    return event.reply(`${boss} 王都没了，你报啥呢？`, true);
  }

  // 伤害溢出
  if (damage > blood[boss - 1]) {
    return event.reply(`伤害值超出 boss 剩余血量，若以斩杀 boss 请使用「尾刀」指令`, true);
  }

  const fight_info = {
    time, syuume, boss, number, damage, user_id, nickname,
    remark: `${nickname} 对 ${boss} 王造成了 ${damage} 点伤害`,
  }
  blood[boss - 1] -= damage;

  if (!history[date]) {
    db
      .get(group_id)
      .last()
      .set(`history.${date}`, [])
      .write()
  }

  db
    .get(group_id)
    .last()
    .set('update', +new Date)
    .set('blood', blood)
    .get(`history.${date}`)
    .push(fight_info)
    .write()
    .then(() => {
      state(event, option);
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
    stage = getStage(syuume);
    blood = all_blood[server][stage - 1];

    db
      .get(group_id)
      .last()
      .set('blood', blood)
      .set('syuume', syuume)
      .write()
      .then(() => {
        event.reply(`所有 boss 已被斩杀，开始进入 ${syuume} 周目`);
      })
  } else {
    stage = getStage(syuume);
  }

  if (server === 'bl') {
    state = `${syuume} 周目 ${stage} 阶段 ${boss} 王\nboss 信息:\n\t${blood[boss - 1]} / ${all_blood[server][stage - 1][boss - 1]}`;
  } else {
    state = `${syuume} 周目 ${stage} 阶段\nboss 信息:`;

    for (let i = 0; i < 5; i++) {
      state += `\n\t${blood[i]} / ${all_blood[server][stage - 1][i]}`;
    }
  }

  event.reply(`当前状态:\n\t${state}\n更新时间:\n\t${getCurrentDate(update)}`)
}

// 发起
function start(event, option) {
  const { group_id } = event;
  const battle = getBattle(group_id);

  // 当前是否开启会战
  if (battle && getLastUpdate(battle.update) < 3) {
    return event.reply('当前已开启会战，请不要重复提交', true);
  }

  const [server] = option.server;
  const [blood] = all_blood[server];
  const default_battle = {
    update: +new Date, blood, syuume: 1, history: {},
  }

  db
    .get(group_id)
    .push(default_battle)
    .write()
    .then(() => {
      let state;

      if (server === 'bl') {
        state = `1 周目 1 阶段 1 王\nboss 信息:\n\t${blood[0]} / ${blood[0]}`;
      } else {
        state = '1 周目 1 阶段\nboss 信息:';

        for (let i = 1; i <= 5; i++) {
          state += `\n\t${blood[i - 1]} / ${blood[i - 1]}`;
        }
      }

      event.reply(`当前状态:\n\t${state}\n更新时间:\n\t${getCurrentDate()}`)
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
        message += `排名：${item.rank}\n公会：${item.clan_name}\n分数：${item.damage}\n---------------\n`;
      }

      message ?
        event.reply(message) :
        event.reply('当月未进行会战，无法获取分数线数据', true)
        ;
    })
    .catch(error => {
      event.reply(error.message)
    })
}

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
    battle = db.get(group_id).first().value();
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

// 数字添加0
function addZero(number) {
  return number < 10 ? '0' + number : number.toString();
}

// 获取当前时间
function getCurrentDate(timestamp) {
  const date = !timestamp ? new Date() : new Date(timestamp);
  const year = date.getFullYear();
  const month = addZero(date.getMonth() + 1);
  const day = addZero(date.getDate());
  const hour = addZero(date.getHours());
  const minute = addZero(date.getMinutes());
  const seconds = addZero(date.getSeconds());
  const CurrentDate = `${year}/${month}/${day} ${hour}:${minute}:${seconds}`;

  return CurrentDate;
}

const command = {
  init: /^设置(国|台|日)服(公|工)会$/,
  start: /^(开启|发起)会战$/,
  stop: /^中止会战$/,
  state: /^状态$/,
  score: /^分数线$/,
  fight: /(^[1-5]?\s?报刀\s?[1-9]\d*$|^[1-5]?\s?尾刀$)/,
  stead: /^@.*\s?[1-5]?\s?\u4EE3\u62A5\s?\d*$/,
}

const default_option = {
  server: ['none', 'bl', 'tw', 'jp'],
}

function listener(event) {
  const option = getOption(event);
  const mission = checkCommand(command, event.raw_message);
  const [server] = option.server;

  if (!mission || !option.apply) return;
  if (server !== 'none' || mission === 'init') {
    eval(`${mission}.bind(this)(event, option)`);
  } else {
    event.reply(`检测到当前群聊未定义游戏服务器，在使用会战功能前请先初始化`);
  }
}

function enable(bot) {
  bot.on('message.group', listener);
}

function disable(bot) {
  bot.off('message.group', listener);
}

module.exports = {
  enable, disable, default_option
}
<div align="center">

<img src="web/public/icon.png" width="96" alt="QQ Farm Bot 图标">

# QQ Farm Bot

QQ 农场自动化工具，支持多账号和 Web 管理面板。

[功能](#功能) · [源码部署](#源码部署) · [Docker 部署](#docker-部署) · [账号登录](#账号登录) · [文档](#文档)

</div>

> [!WARNING]
> 本项目仅供学习和研究。自动化操作可能违反游戏服务条款，账号限制、数据损失等风险由使用者自行承担。请勿用于商业运营、破坏游戏公平性或其他违法违规用途。

<a name="-能做什么"></a>

## 功能

- **多账号管理**：集中查看账号状态，分别配置和启停。
- **日常农活**：收获、种植、浇水、除草、除虫，以及好友相关操作。
- **Web 面板**：实时日志、数据统计、作物图鉴、土地状态和变异效果。
- **任务与活动**：任务、商城和已适配活动的查看与操作。
- **账号登录**：内置微信扫码、手动填码和手机抓包登录。

活动支持随游戏更新而变化，部分活动仅提供只读展示；可用的兑换、抽奖和领取操作以面板为准。

<a name="-开始种田"></a>
<a name="把农场跑起来"></a>

## 源码部署

需要 Node.js 20+、Git 和 pnpm 10。本项目锁定 pnpm `10.30.2`。

```bash
git clone https://github.com/Xb-Fishing/qq-farm-evolution.git qq-farm-bot
cd qq-farm-bot

corepack enable
corepack prepare pnpm@10.30.2 --activate
pnpm install --frozen-lockfile
pnpm build:web

# 仅首次初始化：密码占位符需替换为自己的密码
export FARM_ADMIN_USERNAME='farm_admin'
export FARM_ADMIN_PASSWORD='<your-strong-password>'

bash start.sh
```

启动后在浏览器访问 `localhost:3007`，使用配置的管理员账号登录。

### 管理员初始化

全新数据目录没有默认管理员或默认密码。

- **用户名**：3–32 位英文字母、数字或下划线，例如 `farm_admin`；不能包含中文、空格或连字符 `-`。
- **密码**：6–128 位，包含大写字母、小写字母、数字、特殊符号中的至少两类；禁止使用 `password`、`123456`、`qwerty`、`abc123`、`111111`、`000000`，不区分大小写。
- 仅在数据目录没有管理员时创建；已有管理员不会因修改环境变量而被覆盖或重置密码。
- 源码启动不会自动读取根目录 `.env`，需先 `export`，或在进程管理器中配置环境变量。初始化失败时，日志会指出具体原因。

### 更新源码部署

先停止当前服务，再拉取代码、安装依赖并重新构建：

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build:web
bash start.sh
```

<a name="-docker-部署"></a>

## Docker 部署

需要 Git 和 Docker Compose。先克隆仓库并进入目录：

```bash
git clone https://github.com/Xb-Fishing/qq-farm-evolution.git qq-farm-bot
cd qq-farm-bot
```

首次部署时，在仓库根目录创建 `.env`，将密码占位符替换为自己的密码；用户名和密码遵循上面的初始化规则：

```dotenv
FARM_ADMIN_USERNAME='farm_admin'
FARM_ADMIN_PASSWORD='<your-strong-password>'
```

使用单引号包裹密码，避免 `$` 等字符被展开。已有管理员的部署可省略这一步。

构建并启动：

```bash
docker compose up -d --build
```

更新已有部署时，先执行 `git pull --ff-only`，再执行上述构建命令。

查看状态和日志：

```bash
docker compose ps
docker compose logs -f
```

修改 `.env` 后执行 `docker compose up -d --build --force-recreate`；仅执行 `docker compose restart` 不会更新容器环境。宿主机已导出的同名变量优先于 `.env`，如需改用 `.env`，先执行 `unset FARM_ADMIN_USERNAME FARM_ADMIN_PASSWORD`。

默认映射：

| 用途 | 端口或目录 |
| --- | --- |
| 管理面板 | `3007` |
| 手机抓包代理 | `18000–18999` |
| 持久化数据 | 仓库上级目录的 `data/`，挂载到容器 `/app/core/data` |

<a name="-登录方式"></a>

## 账号登录

<a name="-微信扫码登录"></a>

### 微信扫码

在「添加账号 → 微信扫码」获取二维码，用微信扫码并确认授权。登录流程已内置，无需单独部署扫码服务。

微信授权失效时需要重新扫码。用户设置中提供可选的微信重扫提醒，默认关闭；需配置自己的 Bark Key，并确保手机能访问面板地址。提醒不会代替微信授权。

### 手动填码

在「添加账号」选择对应平台，填写登录 Code，也可粘贴包含 Code 的游戏 WebSocket 地址。

### 手机抓包

1. 在系统设置中启用抓包登录。
2. 进入「添加账号 → 抓包登录」，按页面提示安装并信任证书、配置手机 Wi-Fi 代理。
3. 完全关闭并重新打开 QQ 农场，等待获取 Code。
4. 抓取完成后关闭手机 Wi-Fi 代理。

### 注册与卡密

- 管理员直接登录，无需注册卡密。
- 普通用户注册所需的时间卡密，由本部署管理员创建和提供；额度卡密用于登录后续费。
- 免费领取默认关闭，管理员创建可用时间卡密并开启领取后才可使用。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev:core` | 启动后端和已构建的面板 |
| `pnpm dev:web` | 启动前端开发服务器 |
| `pnpm build:web` | 构建前端 |
| `pnpm lint` | 检查前后端代码 |
| `pnpm -C core test` | 运行后端测试 |

## 数据备份

源码部署默认使用 `core/data/`；Docker 部署使用上表中的持久化目录。升级前请备份数据，妥善保管账号和登录凭据，不要将数据目录、`.env`、日志或密钥提交到公开仓库。

<a name="-使用文档"></a>

## 文档

- [更新记录](docs/CHANGELOG.md)
- [活动适配说明](core/docs/activity-update-runbook.md)
- [TSDK/WASM 更新手册](core/docs/tsdk-update-runbook.md)

感谢上游开源项目和参与贡献、反馈的使用者。

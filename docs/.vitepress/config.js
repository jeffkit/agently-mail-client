import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Agently Mail Client',
  description: '把邮箱变成 AI Agent 的通信通道',
  base: '/agently-mail-client/',
  lang: 'zh-CN',

  themeConfig: {
    logo: '📬',
    nav: [
      { text: '快速开始', link: '/guide/getting-started' },
      { text: '应用场景', link: '/scenarios/chat-with-agent' },
      { text: '配置参考', link: '/reference/config' },
      { text: 'GitHub', link: 'https://github.com/jeffkit/agently-mail-client' },
    ],

    sidebar: [
      {
        text: '指南',
        items: [
          { text: '快速开始', link: '/guide/getting-started' },
          { text: 'Profile 路由', link: '/guide/profiles' },
          { text: '访问控制', link: '/guide/acl' },
        ],
      },
      {
        text: '应用场景',
        items: [
          { text: '邮箱即聊天窗口', link: '/scenarios/chat-with-agent' },
          { text: '批量收集 + 主人决策', link: '/scenarios/batch-mode' },
          { text: '白名单 / 黑名单管理', link: '/scenarios/acl-management' },
        ],
      },
      {
        text: '管理面板',
        items: [
          { text: 'Dashboard 使用', link: '/guide/dashboard' },
        ],
      },
      {
        text: '参考',
        items: [
          { text: '完整配置项', link: '/reference/config' },
          { text: 'P0 协议规范', link: '/reference/protocol' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/jeffkit/agently-mail-client' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025 jeffkit',
    },

    search: { provider: 'local' },
  },
})

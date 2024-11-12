# 请求库封装

## 介绍

基于 axios 二次封装，实现了一些常用的功能，同时保留 axios 的基础配置选项。

## 功能

-   [x] 请求重试
-   [x] 取消重复请求
-   [x] 请求节流
-   [x] 自定义拦截器
-   [x] 请求等待
-   [x] 并发请求限制

## 使用

基于 axios 扩展的配置：

| 参数                  | 默认值 | 说明                                                                                            |
| --------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| retry                 | false  | 配置是否重试                                                                                    |
| retryCount            | 3      | 最大重试次数                                                                                    |
| retryDelay            | 100    | 重试延迟，单位 毫秒                                                                             |
| loading               | false  | 是否开启加载                                                                                    |
| notify                | true   | 是否自动提示                                                                                    |
| enableCancel          | false  | 是否允许取消请求，在 app.vue 或者 main.ts 周期的请求，建议使用 false，开启后可实现防抖效果      |
| throttle              | false  | 是否开启节流，开启后同一个请求需要排队，主要用于重复提交表单的场景（比如订单提交）              |
| wait                  | false  | 是否开启请求等待，开启后，其他请求会等待当前请求结束之后，进行请求（可用于登录或者 token 刷新） |
| maxQueue              | 0      | 并发请求限制                                                                                    |
| prefix                | -      | 请求前缀，一般用于接口版本（比如 v2）或者其他前缀情况                                           |
| randomKey             | ""     | GET 请求唯一标识                                                                                |
| merge                 | false  | 是否合并请求（默认关闭），开启后，多个相同请求会合并成一个请求                                  |
| customResponseHandler | -      | 自定义响应处理函数                                                                              |

返回事件：

| 名称       | 说明                             |
| ---------- | -------------------------------- |
| request    | 具体请求                         |
| clearQueue | 清空请求队列，可用于路由切换场景 |

安装：

```typescript
npm i -S @easyfe/web-request
```

创建请求实例：

```typescript
import { login } from "@/utils/tools/login";
import { storage } from "@/utils/tools/storage";
import uuid from "@/utils/tools/uuid";
import WebRequest from "@easyfe/web-request";

import loading from "./loading";
const service = new WebRequest({
    //axios基础配置和支持的扩展配置
    base: {
        timeout: process.env.VUE_APP_MODE === "production" ? 15000 : 60000, //设置超时时间，生产环境15秒，其他环境60秒
        baseURL: process.env.VUE_APP_MODE === "development" ? process.env.VUE_APP_API_URL : `${storage.getBaseUrl()}`,
        prefix: "/v2",
        headers: {
            "app-type": "gzh"
        },
        randomKey: "_t"
    },
    //加载器实现
    loading,
    //拦截器
    interceptors: {
        //请求拦截器
        request: (config): any => {
            //如果需要拦截请求，可以返回 return Promise.reject("自定义错误")
            const token = storage.getToken();
            if (token && config?.headers) {
                config.headers["access-token"] = token;
            }
            return config;
        },
        //200状态码拦截器
        response: (response): Promise<any> => {
            if (response.data.code !== 200) {
                //失败情况下，完整返回response，可以对config等数据进行修改
                return Promise.reject(response);
            } else {
                //成功状态下，直接返回业务逻辑需要的数据
                return Promise.resolve(response.data.data);
            }
        },
        //非200状态码拦截器
        responseError: (errorResponse): Promise<any> => {
            return Promise.reject(errorResponse);
        }
    }
});

const request = service.request;

export function clearRequest(): void {
    service.clearQueue();
}

export default request;
```

创建加载器（该加载器实现了合并 loading 的功能）：

```typescript
import { Toast } from "vant";
let reqNum = 0;
const loading = {
    showToast(err): void {
        Toast({
            message: err.message || err.errMsg || err.msg || String(err)
        });
    },
    showLoading(): void {
        if (reqNum === 0) {
            Toast.loading({
                duration: 0
            });
        }
        reqNum++;
    },
    clearLoading(): Promise<boolean> {
        /** 合并loading */
        return new Promise((resolve) => {
            setTimeout(() => {
                closeLoading();
                resolve(true);
            }, 300);
        });
    },
    clearToast(): void {
        Toast.clear();
    }
};
/** 关闭loading */
function closeLoading(): void {
    if (reqNum <= 0) {
        return;
    }
    reqNum--;
    if (reqNum === 0) {
        Toast.clear();
    }
}

export default loading;
```

使用：

```typescript
import request from "@/packages/request/index";

export function ReadAccountList(params: listParams): Promise<accoundtList> {
    return request({
        url: "/app/account/index",
        method: "get",
        retry: true,
        params
    });
}
```

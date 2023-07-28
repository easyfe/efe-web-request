import axios, { AxiosInstance, AxiosPromise, AxiosRequestConfig, AxiosResponse, Canceler } from "axios";
import { cloneDeep, genrateNanoid } from "./util";

declare module "axios" {
    interface AxiosRequestConfig {
        /**是否重试（默认关闭）*/
        retry?: boolean;
        /**最大重试次数（默认3次）*/
        retryCount?: number;
        /**重试延迟（默认100毫秒）*/
        retryDelay?: number;
        /**当前重试次数*/
        retryActiveCount?: number;
        /**是否开启加载（默认关闭）*/
        loading?: boolean;
        /**是否开启提示（默认开启）*/
        notify?: boolean;
        /**是否允许主动取消请求（默认关闭），允许后，可以实现队列功能，默认返回最后一个请求结果*/
        enableCancel?: boolean;
        /**是否开启节流（默认关闭），开启后同一个请求需要排队*/
        throttle?: boolean;
        /**是否开启请求等待（默认关闭），开启后，其他请求会等待当前请求结束之后，进行请求*/
        wait?: boolean;
        /**接口前缀 */
        prefix?: string;
        /**请求并发数 */
        maxQueue?: number;
        /**GET请求唯一标识 */
        randomKey?: string;
        /**是否合并请求（默认关闭），开启后，多个相同请求会合并成一个请求*/
        merge?: boolean;
    }
}

type RequestTask = AxiosPromise;

type QueueInstance = RequestTask | (() => RequestTask);

type AxiosRequestConfigWithKey = AxiosRequestConfig & { key: symbol };

type QueueDetail = { config: AxiosRequestConfigWithKey; instance: QueueInstance; cancel?: Canceler };

// 定义常见http状态码错误
const httpStatus: { [key: number]: string } = {
    400: "请求参数错误",
    401: "未授权，请登录",
    403: "服务器拒绝访问",
    404: "404 Not Found",
    405: "请求方法不允许",
    408: "请求超时",
    500: "服务器内部错误",
    501: "服务未实现",
    502: "网关错误",
    503: "服务不可用",
    504: "网关超时",
    505: "HTTP版本不受支持"
};

//取消请求
const cancelToken = axios.CancelToken;

class WebRequest {
    /** 请求配置 */
    private baseRequestConfig: AxiosRequestConfig | null = null;
    /** 请求MAP */
    private processQueue: Map<symbol, QueueDetail> = new Map();
    /** 请求等待MAP */
    private peddingQueue: Map<symbol, QueueDetail> = new Map();
    /** 请求实例 */
    private service: AxiosInstance;
    /** 清空请求队列 */
    clearQueue = (): void => {
        const queue = [...this.processQueue, ...this.peddingQueue];
        for (const [key, item] of queue) {
            if (item.config.wait) {
                continue;
            }
            if (item.config.cancelToken instanceof Function) {
                item.config.cancelToken();
            }
            this.processQueue.delete(key);
            this.peddingQueue.delete(key);
        }
    };
    /**
     * 请求封装，支持所有axios基础参数，以下为扩展参数
     * @param retry 是否重试（默认关闭）
     * @param retryDelay 重试延迟（默认100毫秒）
     * @param retryCount 最大重试次数（默认3次）
     * @param loading 是否开启加载（默认关闭）
     * @param notify 是否开启提示（默认开启）
     * @param throttle 是否开启节流（默认关闭），开启后同一个请求需要排队
     * @param enableCancel 是否允许主动取消请求（默认关闭），允许后，可以实现队列功能，默认返回最后一个请求结果
     * @param wait 是否开启请求等待（默认关闭），开启后，其他请求会等待当前请求结束之后，进行请求
     * @param prefix 接口前缀
     * @param maxQueue 请求并发数
     * @param randomKey GET请求唯一标识
     * @param merge 是否合并请求（默认关闭），开启后，多个相同请求会合并成一个请求
     */
    request = (config: AxiosRequestConfig): Promise<any> => {
        // console.log("=====进入request======", JSON.stringify(config));
        return this.decoratorRequest(config);
    };
    /**
     * 限制并发请求
     * @param config
     * @returns
     */
    private decoratorRequest = (config: AxiosRequestConfig) => {
        return new Promise((resolve, reject) => {
            const key = Symbol("requestid");
            const configWithKey = { ...config, key };
            const instance = (): Promise<any> => {
                return new Promise((r, j) => {
                    this.service(configWithKey)
                        .then((res) => {
                            resolve(res);
                            r(res);
                        })
                        .catch((err) => {
                            reject(err);
                            j(err);
                        })
                        .finally(() => {
                            this.processQueue.delete(key);
                            // console.log("删除执行中队列：", this.processQueue.size, [...this.processQueue.entries()]);
                            this._addNextProcess();
                        });
                });
            };
            const adoptRes = this._queueAdopt(configWithKey);
            if (adoptRes) {
                if (adoptRes instanceof Error) {
                    reject(adoptRes);
                } else if (adoptRes instanceof Promise) {
                    resolve(adoptRes);
                } else {
                    resolve(adoptRes());
                }
                return;
            }
            // console.log("并发限制：", config.maxQueue ?? this.baseRequestConfig?.maxQueue);
            // console.log("等待中队列：", this.peddingQueue.size, [...this.peddingQueue.entries()]);
            // console.log("执行中队列：", this.processQueue.size, [...this.processQueue.entries()]);
            // console.log("最后一个待执行：", JSON.stringify(Array.from(this.processQueue.values()).pop()?.config));
            if (
                this.processQueue.size < ((config.maxQueue ?? this.baseRequestConfig?.maxQueue) || Infinity) &&
                Array.from(this.processQueue.values()).pop()?.config.wait !== true
            ) {
                // console.log("进入process执行逻辑");
                this._addQueue({
                    key,
                    queueType: "process",
                    config: configWithKey,
                    instance: instance()
                });
            } else {
                // console.log("进入pedding等待逻辑");
                this._addQueue({
                    key,
                    queueType: "pedding",
                    config: configWithKey,
                    instance
                });
            }
        });
    };
    /**
     * 拦截防抖和节流
     * @param config
     * @returns
     */
    private _queueAdopt(config: AxiosRequestConfigWithKey) {
        // console.log("进入_queueAdopt====", config);
        const checkFn = (queue: Map<symbol, QueueDetail>): Error | null | QueueInstance => {
            for (const [key, item] of queue) {
                if (item.config.url === config.url && item.config.method === config.method) {
                    // console.log("======存在_queueAdopt====", item.config, item.cancel);
                    // 如果配置了节流，则拦截本次请求
                    if (config.throttle) {
                        return new Error("request:fail fast");
                    }
                    //仅在get模式下，允许取消请求
                    const method = item.config.method?.toLocaleUpperCase() || "GET";
                    if (method === "GET") {
                        //如果允许合并请求
                        if (this.baseRequestConfig?.merge ?? config.merge ?? false) {
                            const v1 = cloneDeep(item.config.params);
                            const v2 = cloneDeep(config.params);
                            item.config.randomKey && delete v1[item.config.randomKey];
                            config.randomKey && delete v2[config.randomKey];
                            //如果存在完全相同get请求，则返回上一个请求结果
                            if (JSON.stringify(v1) === JSON.stringify(v2)) {
                                console.warn("完全相同的请求，返回上一个请求结果", item.config.url);
                                return item.instance;
                            }
                        }
                        //如果配置了防抖，则取消重复请求
                        if (item.config.enableCancel && item.cancel) {
                            item.cancel(JSON.stringify(item.config));
                            queue.delete(key);
                        }
                    }
                }
            }
            return null;
        };
        return checkFn(this.processQueue) || checkFn(this.peddingQueue);
    }
    /** 执行下一个请求 */
    private _addNextProcess = (): any => {
        //如果请求队列中最后一个请求，仍然是wait状态，则打断本次执行
        if (Array.from(this.processQueue.values()).pop()?.config.wait === true) {
            return;
        }
        const [key] = this.peddingQueue.keys();
        const item = this.peddingQueue.get(key);
        if (item && item.instance instanceof Function) {
            // console.log("执行下一个请求", item.config);
            item.config.cancelToken = new cancelToken((c) => {
                this._addQueue({
                    key,
                    cancel: c,
                    queueType: "process",
                    config: item.config,
                    instance: (item as any).instance()
                });
            });
            this.peddingQueue.delete(key);
        }
    };
    /** 添加请求队列 */
    private _addQueue = (data: {
        key: symbol;
        queueType: "process" | "pedding";
        cancel?: Canceler;
        config: AxiosRequestConfigWithKey;
        instance: QueueInstance;
    }) => {
        // console.log("进入添加请求队列", data);
        //添加队列
        let _queue: Map<any, any> = new Map();
        if (data.queueType === "process") {
            _queue = this.processQueue;
        } else {
            _queue = this.peddingQueue;
        }
        _queue.set(data.key, {
            cancel: data.cancel,
            instance: data.instance,
            config: {
                url: data.config.url,
                method: data.config.method,
                params: data.config.params,
                data: data.config.data,
                //默认不允许取消请求
                enableCancel: data.config.enableCancel ?? this.baseRequestConfig?.enableCancel ?? false,
                //默认不开启等待
                wait: data.config.wait ?? this.baseRequestConfig?.wait ?? false
            }
        });
    };
    /**
     * 初始化Core
     * @param requestConfig
     */
    constructor(requestConfig: {
        /** axios基础配置*/
        base: AxiosRequestConfig;
        /** 加载器 */
        loading: {
            showLoading: () => void;
            clearLoading: () => void | Promise<any>;
            showToast: (e: string | Record<string, any>) => void;
            clearToast: () => void;
        };
        /** 拦截器 */
        interceptors: {
            /** 请求拦截器 */
            request: (customConfig: AxiosRequestConfig) => Promise<any>;
            /** HTTP请求成功响应拦截器，返回一个Promise，需要实现message定义 */
            response: (customResponse: AxiosResponse) => Promise<any>;
            /** HTTP请求失败响应拦截器，返回一个Promise，需要实现message定义 */
            responseError: (customResponse: AxiosResponse) => Promise<any>;
        };
    }) {
        this.baseRequestConfig = requestConfig.base;
        /** 创建请求实例 */
        this.service = axios.create(requestConfig.base);
        /** 请求拦截器 */
        this.service.interceptors.request.use(
            async (config) => {
                try {
                    // console.log("========进入请求拦截器===========", config);
                    /** 自定义请求拦截器 */
                    await requestConfig.interceptors.request(config);
                    /** 请求前缀配置 */
                    if (config.prefix !== undefined && !config.retryActiveCount) {
                        config.baseURL = `${config.baseURL}${config.prefix.startsWith("/") ? "" : "/"}${config.prefix}`;
                    }
                    /** 随机数配置 */
                    if (config.randomKey && config.method?.toLocaleUpperCase() === "GET") {
                        if (!config.params) {
                            config.params = {};
                        }
                        config.params[config.randomKey] = genrateNanoid();
                    }
                    /** 如果配置了loading */
                    if (config.loading && !config.retryActiveCount) {
                        requestConfig.loading.showLoading();
                    }
                    config.cancelToken = new cancelToken((c) => {
                        const item =
                            this.processQueue.get((config as AxiosRequestConfigWithKey).key) ||
                            this.peddingQueue.get((config as AxiosRequestConfigWithKey).key);
                        if (item) {
                            item.cancel = c;
                        }
                    });
                    return config;
                } catch (e) {
                    return Promise.reject(e);
                }
            },
            (error) => {
                return Promise.reject(error);
            }
        );
        /** 响应拦截器 */
        this.service.interceptors.response.use(
            async (response): Promise<any> => {
                try {
                    //自定义响应拦截器
                    const res = await requestConfig.interceptors.response(response);
                    //关闭loading
                    await requestConfig.loading.clearLoading();
                    //成功则返回拦截器结果
                    return Promise.resolve(res);
                } catch (e) {
                    //如果捕获到代码异常，直接reject
                    if (e instanceof Error) {
                        return Promise.reject(e);
                    }
                    return new Promise((resolve, reject) => {
                        _retry(response)
                            .then((res: any) => {
                                resolve(res);
                            })
                            .catch((error: any) => {
                                reject(error);
                            });
                    });
                }
            },
            async (error): Promise<unknown> => {
                if (error?.response) {
                    //执行错误拦截器钩子
                    try {
                        await requestConfig.interceptors.responseError(error.response);
                        //如果HTTP状态码非200，并且有返回内容
                        return new Promise((resolve, reject) => {
                            _retry(error.response)
                                .then((res: any) => {
                                    resolve(res);
                                })
                                .catch((error: any) => {
                                    reject(error);
                                });
                        });
                    } catch (e) {
                        //如果捕获到代码异常，直接reject
                        if (e instanceof Error) {
                            return Promise.reject(e);
                        }
                        return new Promise((resolve, reject) => {
                            _retry(error.response)
                                .then((res: any) => {
                                    resolve(res);
                                })
                                .catch((error: any) => {
                                    reject(error);
                                });
                        });
                    }
                } else {
                    requestConfig.loading.clearToast();
                    if (axios.isCancel(error)) {
                        //主动取消请求
                        return Promise.reject(new Error(`当前请求已取消：\n${error.message}`));
                    } else if (error === "request:fail fast") {
                        // 开启节流，请求过快
                        return Promise.reject(new Error("请求过快，已拦截"));
                    } else {
                        requestConfig.loading.showToast(error);
                        return Promise.reject(error?.message || error + "" || "未知错误");
                    }
                }
            }
        );
        /** 请求重试 */
        const _retry = (response: AxiosResponse): Promise<any> => {
            const config = response.config as AxiosRequestConfigWithKey;
            if (config.retryActiveCount === undefined) {
                //设置当前重试第几次，默认0
                config.retryActiveCount = 0;
            }
            if (config.retryCount === undefined) {
                //设置重置最大次数，默认3
                config.retryCount = 3;
            }
            if (config.throttle) {
                //如果配置了节流，则重试前删除队列中的当前请求
                this.processQueue.delete(config.key);
            }
            /**
             * 直接返回错误情况
             * 1、重试次数超出上限
             * 2、未开启重试
             */
            if (config.retryActiveCount >= config.retryCount || config.retry !== true) {
                this.processQueue.delete(config.key);
                this.peddingQueue.delete(config.key);
                return new Promise((resolve, reject) => {
                    _reject(response).catch((err) => {
                        reject(err);
                    });
                });
            }

            config.retryActiveCount += 1;
            return new Promise((resolve) => {
                setTimeout(() => {
                    // console.log("=====_retry setTimeout=========", JSON.stringify(config));
                    this.processQueue.delete(config.key);
                    resolve(this.request(config));
                }, config.retryDelay || 100);
            });
        };

        /** 抛出请求异常 */
        const _reject = async (response: AxiosResponse): Promise<any> => {
            const config = response.config as AxiosRequestConfigWithKey;
            //清除loading
            await requestConfig.loading.clearLoading();
            this.processQueue.delete(config.key);
            if (config.notify === false) {
                //如果不需要进行全局错误提示的情况，直接返回promise
                return Promise.reject(response.data);
            }
            //进行全局错误提示
            if (response.data) {
                //如果后端返回了具体错误内容
                requestConfig.loading.showToast(response.data);
                return Promise.reject(response.data);
            }
            if (response.status && httpStatus[response.status]) {
                // 存在错误状态码
                requestConfig.loading.showToast({ message: httpStatus[response.status] });
                return Promise.reject(response.data);
            }
            //如果没有具体错误内容，找后端
            console.error(`后端接口未按照约定返回，请注意：\n${response.config.url}`);
            requestConfig.loading.showToast("未知错误，请稍后再试");
            return Promise.reject(new Error("未知错误，请稍后再试"));
        };
    }
}

export default WebRequest;

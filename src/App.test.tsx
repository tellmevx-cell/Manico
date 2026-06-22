import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App shell", () => {
  it("renders the Manico overview with preserved feature areas", () => {
    render(<App />);

    expect(screen.getByText("Manico")).toBeInTheDocument();
    expect(screen.getAllByText("应用启动").length).toBeGreaterThan(0);
    expect(screen.getAllByText("窗口绑定").length).toBeGreaterThan(0);
    expect(screen.getAllByText("窗口置顶").length).toBeGreaterThan(0);
    expect(screen.getAllByText("窗口调光").length).toBeGreaterThan(0);
    expect(screen.getByText("快捷添加启动")).toBeInTheDocument();
    expect(screen.getAllByText("快捷启动").length).toBeGreaterThan(0);
    expect(screen.queryByText("热键中心")).toBeNull();
  });
});

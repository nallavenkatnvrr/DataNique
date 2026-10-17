import * as React from "react";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryState {
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

/**
 * Catches React render errors and shows a friendly fallback UI
 * instead of a blank white screen.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ error, errorInfo });
    // Could also report to a logging service here
    console.error("React error boundary caught:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ error: null, errorInfo: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-6">
          <div className="max-w-2xl w-full rounded-lg border bg-card p-8 shadow-lg">
            <div className="flex items-start gap-4">
              <div className="h-12 w-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center shrink-0">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-bold mb-1">Something went wrong</h1>
                <p className="text-sm text-muted-foreground mb-4">
                  An unexpected error occurred in the UI. Your data is safe - only the rendering failed.
                </p>
                <details className="mb-4">
                  <summary className="text-sm font-medium cursor-pointer hover:underline">
                    Error details
                  </summary>
                  <pre className="mt-2 text-xs bg-muted p-3 rounded-md overflow-auto max-h-60 whitespace-pre-wrap">
                    {this.state.error.message}
                    {this.state.errorInfo?.componentStack && (
                      <>
                        {"\n\nComponent stack:"}
                        {this.state.errorInfo.componentStack}
                      </>
                    )}
                  </pre>
                </details>
                <div className="flex gap-2">
                  <Button onClick={this.handleReset} variant="outline">
                    <RefreshCw className="h-4 w-4" /> Try again
                  </Button>
                  <Button onClick={this.handleReload}>
                    <Home className="h-4 w-4" /> Reload page
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

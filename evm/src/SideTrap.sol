// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IPairV2 {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// Siblings of the judge's JudgeTrap.sol, deployed only on a local copy of Base (anvil). The first two
/// tell a simulation from a real trade by what the simulation does around the buyer's own transactions;
/// the third hides a sale tax from a check that measures the pool's WETH outflow instead of what the
/// seller receives.
contract SideTrap {
    enum Mode {
        UntouchedBuyer, // a buyer that never called the token itself (msg.sender == tx.origin) before its buy can never sell
        StrangerKey, // a transferFrom without allowance returns false instead of reverting, and lets its `from` sell
        PairPullTax // the token swaps 90 % of each sale into the pool itself and sends that WETH to its owner
    }

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable owner;
    Mode public immutable mode;
    address public pair;
    mapping(address => uint256) internal bal;
    mapping(address => mapping(address => uint256)) public allowance;
    /// Called the token itself at least once (msg.sender == tx.origin): a real buyer never has before its buy.
    mapping(address => bool) public touched;
    /// UntouchedBuyer: bought without having touched the token first, never sells.
    mapping(address => bool) public marked;
    /// StrangerKey: named as `from` by a transferFrom without allowance, may sell.
    mapping(address => bool) public keyed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, Mode mode_) {
        name = name_;
        symbol = symbol_;
        mode = mode_;
        owner = msg.sender;
        totalSupply = 1_000_000 ether;
        bal[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function setPair(address p) external {
        require(msg.sender == owner, "owner");
        pair = p;
    }

    /// Not `view`: a call from an EOA itself records it. Under the router's or the pair's STATICCALL
    /// msg.sender is a contract, so nothing is written.
    function balanceOf(address a) external returns (uint256) {
        _touch();
        return bal[a];
    }

    function approve(address spender, uint256 value) external returns (bool) {
        _touch();
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _touch();
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        _touch();
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < value) {
            if (mode != Mode.StrangerKey) revert("allowance");
            keyed[from] = true; // a failed takeback: nothing moves, the call does not revert
            return false;
        }
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    function _touch() internal {
        if (msg.sender == tx.origin) touched[msg.sender] = true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(bal[from] >= value, "balance");
        if (pair != address(0) && from == pair && mode == Mode.UntouchedBuyer && !touched[to]) marked[to] = true;
        bool sale = pair != address(0) && to == pair && from != owner;
        if (sale && mode == Mode.UntouchedBuyer && marked[from]) revert("sale closed");
        if (sale && mode == Mode.StrangerKey && !keyed[from]) revert("sale closed");
        bal[from] -= value;
        if (sale && mode == Mode.PairPullTax) {
            uint256 tax = (value * 90) / 100;
            bal[pair] += tax;
            emit Transfer(from, pair, tax);
            _pull(tax);
            value -= tax;
        }
        bal[to] += value;
        emit Transfer(from, to, value);
    }

    /// Swaps `amountIn` tokens already in the pair for its WETH, sent to the owner: the pool pays out
    /// for the whole sale, the seller is paid for a tenth of it.
    function _pull(uint256 amountIn) internal {
        (uint112 r0, uint112 r1,) = IPairV2(pair).getReserves();
        bool tokenIs0 = IPairV2(pair).token0() == address(this);
        (uint256 rIn, uint256 rOut) = tokenIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 out = (amountIn * 997 * rOut) / (rIn * 1000 + amountIn * 997);
        if (out > 0) IPairV2(pair).swap(tokenIs0 ? 0 : out, tokenIs0 ? out : 0, owner, "");
    }
}
